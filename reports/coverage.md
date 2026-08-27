# Reporte de cobertura

> Run `5c3d628e-f4eb-4d13-8b5e-3ef1176e2838` · sitio `br-trf5` · raíz 2024-05-01..2024-05-31
> Generado 2026-08-27T22:11:41.428Z

## ¿Está todo?

El sitio no pagina y corta en un tope por consulta, así que la completitud no se observa: se
construye. Estas son las cifras que la sostienen.

| | |
|---|---|
| Teselado del rango raíz | ✅ sin huecos ni solapes |
| Días cubiertos | 31 de 31 |
| Particiones resueltas | 26 primarias + 15 por clase |
| Particiones divididas | 27 |
| **GAP declarados** | **0** |
| Procesos únicos | 560 (501 con detalle, 59 que el sitio no pudo renderizar) |
| Documentos | 310 almacenados de 3955 conocidos |

**No hay GAP:** cada partición resolvió por debajo del tope.

## Distribución por mes

| año-mes | procesos | días con datos |
|---|---|---|
| 2024-05 | 560 | 27 |

## Comprobaciones de sanidad

| | id | comprobación | resultado |
|---|---|---|---|
| ✅ | S-1 | the resolved partitions tile the root exactly | 27 leaves cover 31 of 31 days |
| ✅ | S-2 | no partition was left unexhausted | every partition resolved under the cap |
| ✅ | S-3 | every stored case was actually seen in a result page | 560 row(s) observed across partitions, 560 distinct case(s) stored |
| ✅ | S-4 | every case number is well formed | 560 case number(s) parse |
| ✅ | S-5 | case number check digits validate | 1 of 560 fail the mod-97 check, e.g. 0003841-02.2015.8.06.0167 |
| ✅ | S-6 | no stored text carries a mojibake signature | 560 case(s) checked, all clean |
| ✅ | S-7 | fields are populated at the expected rate | every field is within its expected null rate |
| ✅ | S-8 | dates are internally consistent | 20 case(s) whose distribution date falls outside the partition that listed them; 0 movement(s) dated in the future |
| ✅ | S-9 | detailed cases have parties | 0 of 501 detailed case(s) have no party at all |
| ✅ | S-10 | every stored document has a location, a hash and a plausible size | 310 document(s) stored, all with a uri, a hash and a size |
| ⚠️ | S-11 | nothing was abandoned | 59 job(s) exhausted their retries; see npm run dlq:list |

## Documentos pendientes

Quedan 3645 documento(s) conocidos sin descargar, porque el
presupuesto de la corrida se agotó. Están registrados en `juris.blob` con estado `PENDING`;
para completarlos:

```
npm start -- --pdf-budget all
```
