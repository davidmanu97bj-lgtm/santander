#!/usr/bin/env python3
"""Stage a known Explora source release without overwriting unknown remote edits.
No deletes, no Git/cloud writes. Validate the entire plan before copying any file.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import stat
import subprocess

EXCLUDED = {'.git', 'node_modules', 'dist', '.deploy', '.firebase', '__pycache__'}
SECRET_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.crt', '.csr'}

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def source_files(root: Path) -> list[Path]:
    result = []
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in dirs:
            if (Path(parent)/name).is_symlink():
                raise ValueError(f'Enlace simbólico no permitido: {Path(parent)/name}')
        dirs[:] = sorted(name for name in dirs if name not in EXCLUDED)
        for name in sorted(files):
            path = Path(parent)/name
            if path.is_symlink():
                raise ValueError(f'Enlace simbólico no permitido: {path}')
            if name.endswith(('.zip', '.log', '.pyc')):
                continue
            if (name == '.env' or name.startswith(('.env.', 'service-account', 'serviceAccount', 'credentials'))
                    or path.suffix.lower() in SECRET_SUFFIXES or name == '.secret.local'):
                raise ValueError(f'No se empaquetan secretos/configuración privada: {path}')
            result.append(path.relative_to(root))
    return sorted(result)

def check_target(root: Path, relative: Path) -> None:
    cursor = root
    for part in relative.parts:
        cursor /= part
        if cursor.is_symlink():
            raise ValueError(f'El destino contiene un enlace: {relative}')
        if cursor.exists() and cursor != root/relative and not cursor.is_dir():
            raise ValueError(f'Un archivo bloquea la carpeta de destino: {relative}')
    if cursor.exists() and not cursor.is_file():
        raise ValueError(f'El destino no es un archivo normal: {relative}')

class VerifiedGitBase:
    """A release created locally is not evidence that it ever existed on GitHub.

    Prove which files are additions from the original ZIP's Git commit. A file
    added and later removed after that commit remains a conflict, even when its
    old contents are among the known hashes. Uses read-only Git commands only.
    """
    def __init__(self, target: Path, manifest: dict):
        self.target = target
        self.commit = manifest.get('originalGitCommit', '')
        declared = manifest.get('absentFromOriginal', [])
        if not re.fullmatch(r'[0-9a-f]{40}', self.commit):
            raise ValueError('Falta un commit Git original válido en el manifiesto.')
        if not isinstance(declared, list) or not all(isinstance(p, str) for p in declared):
            raise ValueError('Lista de incorporaciones inválida en el manifiesto.')
        self.additions = set(declared)
        if Path(self.git('rev-parse', '--show-toplevel').strip()).resolve() != target.resolve():
            raise ValueError('El destino no es la raíz de un repositorio Git.')
        if self.git('rev-parse', '--is-shallow-repository').strip() != 'false':
            raise ValueError('Historial Git incompleto: se requiere un clon sin --depth.')
        self.head = self.git('rev-parse', '--verify', 'HEAD^{commit}').strip()
        self.git('rev-parse', '--verify', self.commit + '^{commit}')
        result = subprocess.run(['git', '-C', str(target), 'merge-base', '--is-ancestor',
                                 self.commit, self.head], capture_output=True, text=True)
        if result.returncode != 0:
            raise ValueError('La rama no desciende del commit del ZIP original; revisar antes de publicar.')
        self.original_paths = set(self.git('ls-tree', '-r', '--name-only', '-z', self.commit).split('\0'))
        self.confirmed_additions: list[str] = []

    def git(self, *args: str) -> str:
        result = subprocess.run(['git', '-C', str(self.target), *args],
                                capture_output=True, text=True)
        if result.returncode:
            raise ValueError('No se pudo verificar el historial Git. No se copiará ningún archivo. '
                             + result.stderr.strip())
        return result.stdout

    def missing_file_conflict(self, relative: Path) -> str | None:
        name = relative.as_posix()
        if name not in self.additions or name in self.original_paths:
            return f'{relative}: falta un archivo de la base original; no se restaura automáticamente'
        # Do not confuse "absent in both snapshots" with "never added since base".
        # Full history, including merge parents, catches addition/deletion cycles.
        changed = self.git('log', '--full-history', '-m', '--no-renames', '--max-count=1',
                           '--format=%H', f'{self.commit}..{self.head}', '--', f':(literal){name}').strip()
        if changed:
            return (f'{relative}: tuvo cambios en Git después de la base y ahora falta; '
                    'posible eliminación real, no se recrea automáticamente')
        self.confirmed_additions.append(name)
        return None

    def ensure_unchanged_head(self) -> None:
        if self.git('rev-parse', '--verify', 'HEAD^{commit}').strip() != self.head:
            raise ValueError('HEAD cambió durante la comparación. No se copiará ningún archivo.')

def prepare(source: Path, target: Path, manifest: dict) -> tuple[list[Path], list[str]]:
    if source.resolve() == target.resolve() or source.resolve() in target.resolve().parents or target.resolve() in source.resolve().parents:
        raise ValueError('Origen y destino deben ser carpetas independientes.')
    if manifest.get('schemaVersion', 1) not in (1, 2):
        raise ValueError('Versión de manifiesto no reconocida.')
    known = manifest.get('files', {})
    verified = VerifiedGitBase(target, manifest) if manifest.get('schemaVersion', 1) == 2 else None
    paths = source_files(source)
    conflicts = []
    for relative in paths:
        check_target(target, relative)
        incoming = digest(source/relative)
        allowed = known.get(relative.as_posix(), [])
        current = target/relative
        if current.exists():
            actual = digest(current)
            if actual != incoming and actual not in allowed:
                conflicts.append(f'{relative}: versión remota distinta de las versiones conocidas')
        elif verified:
            conflict = verified.missing_file_conflict(relative)
            if conflict:
                conflicts.append(conflict)
        elif allowed:
            # Legacy manifests remain conservative; absence alone proves nothing.
            conflicts.append(f'{relative}: eliminado en GitHub respecto de la base; no se recrea automáticamente')
    if verified:
        verified.ensure_unchanged_head()
    return paths, conflicts

def overlay(source: Path, target: Path, manifest: dict, apply: bool = False) -> dict:
    paths, conflicts = prepare(source, target, manifest)
    if conflicts:
        return {'ok': False, 'conflicts': conflicts, 'files': [p.as_posix() for p in paths]}
    if apply:
        for relative in paths:
            destination = target/relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            # The clone is private to this execution. Do not follow filesystem links.
            check_target(target, relative)
            shutil.copyfile(source/relative, destination, follow_symlinks=False)
            mode = 0o755 if relative.suffix in {'.sh', '.py'} else 0o644
            destination.chmod(mode)
    return {'ok': True, 'conflicts': [], 'files': [p.as_posix() for p in paths]}

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    source, target = args.source.resolve(), args.target.resolve()
    if not source.is_dir() or not target.is_dir():
        parser.error('Origen y destino deben existir.')
    try:
        result = overlay(source, target, json.loads(args.manifest.read_text()), args.apply)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        result = {'ok': False, 'conflicts': [str(error)], 'files': []}
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    if not result['ok']:
        print('\n'.join(result['conflicts']))
        raise SystemExit('DETENIDO: la comparación no es segura. Revisar comparacion.json; no se forzó ningún cambio.')
    print(f"{len(result['files'])} archivos comprobados; {'copiados' if args.apply else 'solo revisión'}.")

if __name__ == '__main__':
    main()
