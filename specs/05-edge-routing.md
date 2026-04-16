# 05 — Edge Routing

## Algoritmo (v1, M4)

Manhattan ortogonal con 2-elbow máximo. Pasos:

### 1. Elegir lados

Para cada ref, dado bbox source y bbox target:

```
dx = targetCenter.x - sourceCenter.x
dy = targetCenter.y - sourceCenter.y

if |dx| >= |dy|:   # horizontal dominant
  if dx >= 0: source→right, target→left
  else:       source→left,  target→right
else:              # vertical dominant
  if dy >= 0: source→bottom, target→top
  else:       source→top,    target→bottom
```

Esto garantiza que el edge "apunta hacia" el target desde el lado correcto, y viceversa.

### 2. Distribuir ports en cada lado

Múltiples edges compartiendo un lado de una tabla causarían solapamiento si todos usaran el centro. Solución:

- Agrupar edges por `(tableName, side)` (source y target independientes → un edge participa en dos grupos).
- Sortar cada grupo por el "otro extremo": para lado horizontal sortar por y del otro extremo; para lado vertical sortar por x. Esto reduce cruces.
- Asignar `ratio = (i + 1) / (n + 1)` para i=0..n-1 → ports equidistantes que nunca tocan las esquinas.

### 3. Computar path

Dado `a = portPoint(src, sourceSide, sourceRatio)` y `b = portPoint(tgt, targetSide, targetRatio)`:

| source H? | target H? | Path |
|---|---|---|
| Sí (left/right) | Sí | `M a H midX V b.y H b.x` (H→V→H, 2 elbows) |
| No (top/bottom) | No | `M a V midY H b.x V b.y` (V→H→V, 2 elbows) |
| Sí | No | `M a H b.x V b.y` (H→V, 1 elbow) |
| No | Sí | `M a V b.y H b.x` (V→H, 1 elbow) |

`midX = (a.x + b.x) / 2`, `midY = (a.y + b.y) / 2`.

### 4. Port ratio clamp

Clamp a `[0.05, 0.95]` para evitar que el port toque la esquina (artefactos visuales).

## Limitaciones conocidas v1

1. **No evita tablas en el camino**. Si hay una tabla entre source y target, el edge la atraviesa. Algoritmo A* con obstacle avoidance llega en v2.
2. **Choice de lado binario**. Tabla a 45° exactamente elige horizontal por tie-breaker `>=`. Aceptable.
3. **Distribución de ports desconoce self-loops**. Refs de una tabla a sí misma (raro en DBML pero legal) producirían path degenerado. No crash pero visual feo. Fix en v1.1.
4. **Sin curvatura en elbows**. 90° rígidos. v1.1 puede añadir `stroke-linejoin: round` o corners redondeados.

## Caching y recomputación

`routeRefs()` se llama dentro del componente `EdgeLayer` en cada render. Como `EdgeLayer` recibe `refs` ya filtrados por visibilidad (del `app.tsx`), el trabajo por frame escala con edges visibles, no con total.

Optimización futura si se nota jank: memoizar routes por `(schema, positions)` con useMemo. En v1, recomputar en cada viewport change es aceptable para <500 visibles.

## Flechas / direccionalidad

v1 no dibuja flechas. El orden `source→target` en el path es suficiente semánticamente; visualmente todos los edges se ven iguales. Agregar marcadores `<marker>` SVG en v1.1 para distinguir `1:*` vs `*:*` etc.

## Test plan

`test/unit/edgeRouter.test.ts`:
- Dos tablas en misma fila, target a la derecha → source=right, target=left, path H-V-H.
- Dos tablas en misma columna, target abajo → source=bottom, target=top, path V-H-V.
- Target arriba-derecha → horizontal gana (45° tiebreak).
- 3 edges al mismo lado derecho de una tabla → ratios 0.25, 0.5, 0.75.
- Edge con bbox faltante → omitido del output (no crash).
