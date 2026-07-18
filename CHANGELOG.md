# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] - 2026-07-18

### Added

- **Maison Vauron provider** (`maisonvauron`) — read-only, anonymous access to
  [mvauron.co.nz](https://www.mvauron.co.nz), an Auckland French wine + gourmet-food
  retailer on the Black Pepper platform. `search_products`, `browse_products` and
  `get_specials` parse the `window.category` catalogue blob each list page
  server-renders. Wine is priced per bottle; cart/login/orders are not supported
  (same tier as the Farro and Warehouse providers).
