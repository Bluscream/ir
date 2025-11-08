# IR Pattern Converter

Static web interface for converting between common infrared signal formats and retrieving live metadata from Flirc's IRSock service.

## Features

- Bidirectional conversion between:
  - Raw `+/-` pulse spacing strings
  - CSV pulse lists
  - Pronto hex
  - LIRC style microsecond timings
  - JSON arrays
  - Arduino IRremote `rawData` snippets
- Automatic carrier frequency handling with manual override.
- Debounced requests to `https://irsock.flirc.io:3030/endpoint` for protocol metadata that is rendered in-page and included in the export.
- Single-click export of a consolidated JSON document containing metadata and every supported format.

## Local Development

No build tooling is required. Serve the directory or open `index.html` directly in a browser that supports the Clipboard API and `fetch`.

```bash
python -m http.server 8080
```

Then navigate to `http://localhost:8080/index.html`.

## Usage

1. Paste a pattern into any input field.
2. The remaining fields populate automatically.
3. The carrier frequency field updates when possible (e.g., when Pronto hex supplies it).
4. Inspect the fetched IRSock metadata in the sidebar.
5. Use **Copy All Formats** to copy a canonical JSON payload for downstream tooling.

## Deployment

Push the contents of this directory to the `bluscream.github.io` repository under the `ir` path, or host directly as part of a GitHub Pages project site.

