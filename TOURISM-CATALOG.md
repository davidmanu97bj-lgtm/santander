# Catálogo turístico precalculado

42 puntos y 1.722 combinaciones direccionales. Fuente de coordenadas: HeiGIT/Pelias. Distancias en automóvil: HeiGIT/OpenRouteService Matrix, calculadas el 12/09/2026, en kilómetros. No son distancias de Google ni una certificación fiscal.

La aplicación usa este catálogo sin consultar mapas al cobrar. Las distancias son estimadas por carretera, no mediciones GPS del servicio. No se representa la totalidad de los establecimientos turísticos de la región.

## Lugares incluidos

### Iguazú

- Aeropuerto Internacional de Puerto Iguazú
- Terminal de Ómnibus de Puerto Iguazú
- Hito Tres Fronteras
- La Aripuca
- GüiráOga
- Loi Suites Iguazú
- Iguazú Grand Hotel
- Panoramic Grand
- Mercure Iguazú Hotel Iru
- Gran Hotel Tourbillon Cataratas
- Grand Crucero Iguazú
- Mérit Iguazú Hotel
- Jardín de los Picaflores

### Wanda

- Minas Wanda
- Terminal de Ómnibus de Wanda

### Puerto Libertad

- Museo Regional Puerto Bemberg
- Parque Acuático Lago Urugua-í
- Terminal de Ómnibus de Puerto Libertad

### Foz do Iguaçu

- Parque das Aves
- Centro de Visitantes - Parque Nacional das Cataratas do Iguaçu
- Marco das Três Fronteiras
- Centro de Recepção de Visitantes - Usina de Itaipu
- Mesquita Omar Ibn Al-Khattab
- Rodoviária Internacional
- Dreams Ice Bar
- Hotel Bourbon Cataratas
- Hotel Viale Cataratas
- Vivaz Cataratas Hotel Resort
- Aeroporto Internacional das Cataratas de Foz do Iguaçu

### Ciudad del Este

- Shopping del Este
- Shopping China
- Lago Shopping de Salemma
- Shopping Macro
- Shopping Pacific
- Iglesia Catedral San Blas
- Terminal de Ómnibus de Ciudad del Este

### Hernandarias

- Museo Tierra Guaraní (Itaipú)
- ITAIPU Binacional - Centro de Recepcion de Visitas
- Refugio Tatí Yupí
- Terminal de Ómnibus - Hernandarias
- Acceso Costanera - Hernandarias

## Pendientes de acceso preciso

Gran Meliá, estacionamiento argentino del Parque Nacional Iguazú, Templo Budista y Belmond Hotel das Cataratas: los puntos iniciales se ajustaban a calles a más de 150 m. No se publicaron esos recorridos. La Costanera de Hernandarias se reemplazó por su acceso identificado. Aeropuerto de Foz conserva ajuste de 150,53 m; revisar accesos en uso operativo. Museo Nuestra Señora del Iguazú y Mina Don José: no se encontró una coincidencia geográfica inequívoca.

## Fuentes para identificar atractivos

- https://www.wanda.gob.ar/turismo
- https://visitiguazu.travel/atractivos/
- https://www.iguazu.gob.ar/historia/
- https://www.destino.foz.br/
- https://www.itaipu.gov.py/turismo/visitas
- https://senatur.gov.py/informaciones-turisticas/
- https://giscience.github.io/openrouteservice/api-reference/endpoints/matrix/

## Cataratas Argentina

Se incorpora el acceso vial identificado por HeiGIT/Pelias como Acceso a las Cataratas del Iguazú, en [-54.475139,-25.689604], con ajuste a carretera de 0,07 m. Las distancias terminan en ese acceso vial y no en el estacionamiento, que continúa pendiente de coordenadas verificadas. Referencia oficial del acceso: https://iguazuargentina.com/planifica-tu-visita/faqs/ . La terminal de Puerto Iguazú hasta este acceso arroja 14,5 km. No presentar esa cifra como distancia hasta el estacionamiento.

El buscador local elimina tildes y permite prefijos y pequeños errores (incluida transposición); solo se guarda una selección explícita del catálogo. Cambiar el texto invalida la selección y la distancia.
