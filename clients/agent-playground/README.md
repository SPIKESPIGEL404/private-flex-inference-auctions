# Compatibility entry point

The canonical frontend lives in [`../market-playground`](../market-playground/README.md).
Install its dependencies with `npm ci --prefix clients/market-playground` from
the repository root. This package's `dev` and `build` commands delegate there;
its source aliases the same application and styles. There is no second UI.
