# Orator File Service

> Reusable Orator byte + tile serving — HTTP Range, a resolver seam, and libvips DZI tiles.

- **HTTP Range (206) byte serving** — streaming `serveFile` + a pure `planByteRange`; 200 / 206 / 416 / HEAD
- **Resolver seam (tenancy stays in the app)** — the host maps a request to an absolute path; the service owns no identity or auth
- **libvips Deep Zoom tiles** — `retold-sharp` `dzsave` DZI pyramids, streamed and bounded-memory, for enormous images
- **Pre-bake cache + on-the-fly fallback** — tiles bake once and serve statically, or render per-request when absent
- **Capability-gated** — tiling returns `501` cleanly when libvips is not installed
- **The server half** of the `pict-section-fileview` deep-zoom and media story

[Overview](README.md)
[Configuration](configuration.md)
[Architecture](architecture.md)
[GitHub](https://github.com/fable-retold/orator-file-service)
