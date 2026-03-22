# Configuration System

> Component configuration for CSA.IBKR — every module gets its own config directory

## Structure

```
configs/
├── gateway/         ← IBKR gateway connection settings
│   └── json/
│       ├── config.json      ← All environments (replaces conf.*.yaml files)
│       └── endpoints.json   ← Complete API endpoint catalog
├── main.chart/      ← Main chart component
│   ├── js/          ← Layout, dynamics
│   ├── css/         ← Chart-specific styles
│   └── json/        ← Chart defaults (timeframe, indicators, colors)
├── dock/            ← Floating dock
├── auth/            ← Login flow
├── scanner/         ← Market scanner
├── positions/       ← Positions panel
├── fundamentals/    ← Fundamentals panel
└── news/            ← News panel
```

## YAML → JSON Migration

| Original YAML | JSON Equivalent | Notes |
|--------------|-----------------|-------|
| `conf.yaml` | `config.json` → `environments.production` | Main production config |
| `conf.alpha.yaml` | `config.json` → `environments.alpha` | Alpha/staging |
| `conf.api.alpha.yaml` | `config.json` → `environments.api-alpha` | API alpha |
| `conf.beta.yaml` | `config.json` → `environments.beta` | Beta testing |
| `conf.tws.yaml` | `config.json` → `environments.tws` | TWS-compatible |
| `logback.xml` | `config.json` → `logging` | Log levels per module |
| `vertx.jks` | *(eliminated)* | Browser handles TLS |

## Adding New Components

Each component config directory follows the pattern:
```
component-name/
├── js/           ← JavaScript logic specific to this component
├── css/          ← Component-specific styles
└── json/
    └── config.json  ← Component configuration
```

Import the config in your component:
```javascript
const config = await fetch('/system/configs/component-name/json/config.json').then(r => r.json());
```
