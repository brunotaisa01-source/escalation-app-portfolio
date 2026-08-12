# Webpack setup

Run these commands from `frontend/` in PowerShell:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npx.cmd webpack --version
npm.cmd test
npm.cmd run build
```

The build writes `frontend/dist/index.html` and `frontend/dist/assets/app.js`. Build output is generated from the sanitized source and must be scanned before public delivery.
