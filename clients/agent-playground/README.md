# Compatibility entry point

The canonical frontend lives in [`../market-playground`](../market-playground/README.md).
Install its dependencies with `npm ci --prefix clients/market-playground` from
the repository root. This package's `dev` and `build` commands delegate there;
its source aliases the same application and styles. The opt-in OutLayer P3 runtime has a separate bounded-acceptance entry: `npm run build:p3`
outputs `dist-p3/p3.html`, and `npm run dev:p3` opens its development server. These
commands do not change the canonical Mono build. See [P3 setup and acceptance](../../docs/agent-mpp-p3.md).
