// Receipt uploads are independent of monetary calculations and keep the same operation ID.
export function operationTimeout(message = "La conexión tardó demasiado. Volvé a intentar.") {
  return Object.assign(new Error(message), { code:"operation-timeout" });
}

export function withOperationDeadline(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(operationTimeout(message)), milliseconds); })
  ]).finally(() => clearTimeout(timer));
}

export function receiptContentType(file) {
  const type = String(file?.type || "").toLowerCase().split(";")[0];
  if (type && type !== "application/octet-stream") return type === "image/jpg" ? "image/jpeg" : type;
  const extension = String(file?.name || "").split(".").pop().toLowerCase();
  return ({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",heic:"image/heic",heif:"image/heif",pdf:"application/pdf"})[extension] || type;
}

function decodeReceiptImage(file, timeoutMs) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    const release = () => { image.onload = null; image.onerror = null; image.src = ""; URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { release(); reject(operationTimeout()); }, timeoutMs);
    image.onload = () => {
      clearTimeout(timer);
      if (!image.naturalWidth || !image.naturalHeight) { release(); reject(new Error("Imagen sin dimensiones.")); return; }
      resolve({image, width:image.naturalWidth, height:image.naturalHeight, release});
    };
    image.onerror = () => { clearTimeout(timer); release(); reject(new Error("No se pudo procesar la imagen.")); };
    image.src = url;
  });
}

export async function prepareReceiptFile(file, {
  maxDimension = 2000, quality = .82, timeoutMs = 10000,
  decodeImage = decodeReceiptImage, createCanvas = () => document.createElement("canvas")
} = {}) {
  if (!(file?.size > 0)) throw Object.assign(new Error("Elegí un comprobante que no esté vacío."), {code:"receipt/invalid-file"});
  if (file.size > 15 * 1024 * 1024) throw Object.assign(new Error("El comprobante debe pesar hasta 15 MB."), {code:"receipt/file-too-large"});
  const type = receiptContentType(file);
  if (!(type.startsWith("image/") || type === "application/pdf")) throw Object.assign(new Error("Elegí una imagen o un PDF como comprobante."), {code:"receipt/invalid-file"});
  // PDFs and small screenshots already travel efficiently, preserving all their detail.
  if (type === "application/pdf" || file.size <= 350 * 1024) return file;
  let decoded;
  try {
    decoded = await decodeImage(file, timeoutMs);
    const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
    const canvas = createCanvas();
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
    const blob = await withOperationDeadline(new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality)), timeoutMs);
    if (!blob?.size || blob.size >= file.size) return file;
    const name = String(file.name || "comprobante").replace(/\.[^.]*$/, "") + ".jpg";
    return new File([blob], name, {type:"image/jpeg", lastModified:file.lastModified || Date.now()});
  } catch (_) {
    // An unsupported mobile codec must not prevent an otherwise valid original upload.
    return file;
  } finally {
    decoded?.release?.();
  }
}

export async function uploadReceiptFile({
  reference, file, uploadBytesResumable, getDownloadURL, onProgress = () => {},
  idleTimeoutMs = 45000, totalTimeoutMs = 120000, urlTimeoutMs = 15000
}) {
  const snapshot = await new Promise((resolve, reject) => {
    let task, unsubscribe, idleTimer, totalTimer;
    let settled = false, bytesTransferred = -1;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer); clearTimeout(totalTimer);
      try { unsubscribe?.(); } catch (_) {}
      if (error) reject(error); else resolve(result);
    };
    const timeout = () => {
      const error = operationTimeout("La carga del comprobante dejó de avanzar. Revisá la conexión y volvé a intentar.");
      error.stage = "upload";
      // Settle first: cancel() may synchronously emit storage/canceled.
      finish(error);
      try { task?.cancel?.(); } catch (_) {}
    };
    const report = current => {
      if (settled) return;
      const count = Number(current.bytesTransferred || 0);
      if (count > bytesTransferred) { bytesTransferred = count; clearTimeout(idleTimer); idleTimer = setTimeout(timeout, idleTimeoutMs); }
      const total = Number(current.totalBytes || file.size);
      try { onProgress(Math.max(0, Math.min(100, Math.round(count / total * 100)))); } catch (_) {}
    };
    totalTimer = setTimeout(timeout, totalTimeoutMs);
    idleTimer = setTimeout(timeout, idleTimeoutMs);
    try {
      task = uploadBytesResumable(reference, file, {contentType:receiptContentType(file)});
      report(task.snapshot || {bytesTransferred:0});
      unsubscribe = task.on("state_changed", report, error => finish(error), () => finish(null, task.snapshot));
      if (settled) unsubscribe?.();
    } catch (error) { finish(error); }
  });
  const url = await withOperationDeadline(getDownloadURL(snapshot.ref), urlTimeoutMs, "El comprobante se subió, pero falta confirmar su enlace. Volvé a intentar.");
  return {url, reference:snapshot.ref};
}

export async function runBoundedTransaction(runTransaction, db, handler, timeoutMs = 45000) {
  let active = true;
  try {
    return await withOperationDeadline(runTransaction(db, async transaction => {
      if (!active) throw operationTimeout();
      const result = await handler(transaction);
      // If a read returns after the deadline, do not commit its staged writes.
      if (!active) throw operationTimeout();
      return result;
    }, {maxAttempts:3}), timeoutMs, "La conexión tardó demasiado en confirmar el guardado.");
  } finally { active = false; }
}

// Preparing a receipt and confirming its payment share the same upload. The
// newest caller owns progress updates; a stale form must not keep receiving them.
export function createReceiptUploadCache({prepareFile, uploadFile, createPath}) {
  if (![prepareFile, uploadFile, createPath].every(value => typeof value === "function")) {
    throw new TypeError("Faltan las funciones de preparación y carga del comprobante.");
  }
  const files = new WeakMap();
  const notify = entry => {
    try { entry.onProgress?.({...entry.progress}); } catch (_) {}
  };
  const update = (entry, stage, percent) => {
    if (entry.finished) return;
    entry.progress = {stage, percent:Math.max(0, Math.min(100, Number(percent) || 0))};
    notify(entry);
  };

  return {
    get(file, scope, onProgress) {
      if (!file || typeof file !== "object" || typeof scope !== "string" || !scope.trim()) {
        return Promise.reject(Object.assign(new Error("No se pudo identificar el comprobante o su usuario."), {code:"receipt/invalid-file"}));
      }
      let scopes = files.get(file);
      if (!scopes) { scopes = new Map(); files.set(file, scopes); }
      let entry = scopes.get(scope);
      if (entry) {
        entry.onProgress = typeof onProgress === "function" ? onProgress : null;
        notify(entry);
        if (entry.finished) entry.onProgress = null;
        return entry.promise;
      }

      entry = {onProgress:typeof onProgress === "function" ? onProgress : null,
        progress:{stage:"prepare", percent:0}, finished:false, promise:null};
      scopes.set(scope, entry);
      // Defer work until the promise is installed so overlapping callers always
      // receive exactly the same promise, including during synchronous callbacks.
      entry.promise = Promise.resolve().then(async () => {
        notify(entry);
        const preparedFile = await prepareFile(file);
        const path = await createPath(preparedFile, scope);
        if (typeof path !== "string" || !path.trim()) {
          throw Object.assign(new Error("No se pudo preparar la ruta del comprobante."), {code:"receipt/invalid-path"});
        }
        update(entry, "upload", 0);
        const uploaded = await uploadFile({file:preparedFile, path, onProgress:value => {
          const percent = typeof value === "object" ? value?.percent : value;
          const stage = value?.stage === "url" || Number(percent) >= 100 ? "url" : "upload";
          update(entry, stage, percent);
        }});
        const url = typeof uploaded?.url === "string" ? uploaded.url.trim() : "";
        let valid = false;
        try { valid = ["https:", "http:"].includes(new URL(url).protocol); } catch (_) {}
        if (!valid) throw Object.assign(new Error("El comprobante todavía no tiene un enlace válido."), {code:"receipt/invalid-url"});
        update(entry, "ready", 100);
        return {url, path};
      }).catch(error => {
        if (scopes.get(scope) === entry) scopes.delete(scope);
        throw error;
      }).finally(() => {
        entry.finished = true;
        entry.onProgress = null;
      });
      return entry.promise;
    }
  };
}
