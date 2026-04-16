# 07 — Performance Budgets

## Objetivo maestro

DBML de 5000 tablas abierto en una laptop decente (Chromium webview, sin WebGL), navegación fluida a 60fps sostenidos durante pan/zoom, sin frames individuales por debajo de 30fps.

## Fixtures

| Fixture | Tablas | Refs | Uso |
|---|---|---|---|
| `test/fixtures/tiny.dbml` | 5 | 4 | Smoke test M1/M2 |
| `test/fixtures/medium.dbml` | ~200 | ~150 | Benchmark día-a-día, regresión |
| `test/fixtures/huge.dbml` | ~5000 | ~1000 | Stress test, generated por `scripts/gen-huge-fixture.mjs` |

## Budgets numéricos (medir en M3 y regresar en M5, M6, M7)

| Métrica | Budget | Cómo medir |
|---|---|---|
| Parse DBML 5000 tablas | < 2000ms | `performance.now()` alrededor de `Parser.parse()` en host |
| Auto-layout dagre 5000 tablas | < 3000ms | `performance.now()` alrededor de `autoLayout()` |
| Postmessage payload 5000 tablas | < 10MB | `JSON.stringify(schema).length` |
| Webview idle memory | < 200MB | Task Manager de VSC |
| FPS pan continuo 10s | >= 55 avg, >= 30 p99 | DevTools Performance tab + `requestAnimationFrame` timing |
| FPS zoom continuo | >= 55 avg | idem |
| Drag single table | < 16.7ms por frame (60fps) | DevTools Performance, M5 |
| Write layout file | < 50ms | `performance.now()` alrededor del fs.write |

## Cómo medir FPS en webview

`Developer: Open Webview Developer Tools` → Performance tab → Record → pan continuo 10s → Stop → ver "Frames" track.

Alternativa programática (agregar en debug build):

```ts
let frames = 0;
let lastTick = performance.now();
function tick() {
  frames++;
  const now = performance.now();
  if (now - lastTick >= 1000) {
    console.log('fps', frames);
    frames = 0;
    lastTick = now;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

## Bundle size budget

| Artefacto | Budget | Actual (M3) |
|---|---|---|
| `dist/webview/webview.js` (gzipped) | < 40kb | ~29kb post-M2 |
| `dist/webview/webview.js` (uncompressed) | < 200kb | ~106kb post-M2 |
| `dist/extension/**` (uncompressed) | < 50kb | tbd |

Librerías pesadas (cuidado):
- `@dbml/core` corre sólo en host → no afecta webview.
- `@dagrejs/dagre` corre en webview (auto-layout) → ~30kb gzipped. Aceptable v1. Migrar a Web Worker si se nota jank en auto-layout inicial (v1.1).

## Regresiones conocidas a vigilar

- **Re-render en cada pan frame**: síntoma = FPS cae a <30 durante pan. Check: `React DevTools Profiler` (o `preact/devtools`), identificar componentes que re-renderizan sin necesidad. Memoize con `useMemo`.
- **Spatial index rebuild en pan**: `useEffect` deps incluye `viewport` por error. Check: effect de `idx.clear()` debe depender sólo de `schema` y `positions`, nunca viewport.
- **Edge overlay sin culling**: si se dibujan 1000 paths SVG innecesarios, perf cae. Check: `visibleRefs.length` en statusbar con diagrama grande.
- **Dagre call en render path**: auto-layout sólo en effect post-schema-change, nunca en render puro.

## Notas de ingeniería

- Las transformaciones CSS de world container (`translate + scale`) se componen en GPU y no re-layout los hijos.
- Texto dentro de tablas cambia calidad al cambiar zoom — esto es esperado por el resample de Chrome. A zoom < 0.3 el texto es ilegible y por eso LOD='rect' no lo renderiza.
- ResizeObserver del viewport puede disparar con throughput alto; debounce si se ve problema (no observado aún).
