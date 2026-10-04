# ZTM Build Fest 2026
## MusicFeed - Publish your Favourites

### User Story
A place where I record what I'm listening to, and it publishes to my music blog [Crusty Metallian](https://crusty-metallian.net) without me manually having to touch the site. This satisfies my want to share what I'm listening to so that others can see, enjoy, and discover new music that might have been unknown to them.

### Guiding Principles

*Use of AI*
I'm using AI in two ways:
1. To guide the overall development of the project, including big brainstorming.
2. I'll be using my own harness [Rho Code](https://rho-code.dev) as a research assistant and pair programmer. It will provide me a sounding board and act as a pair programmer and reviewer.

*Starter Template*
My API will be founded in a starter I built myself: [Axum-Tera-Datastar](https://github.com/crustyrustacean/axum-tera-datastar.git)

### How to Download and Run

MusicFeed lives inside the ZTM Build Fest monorepo, so clone the whole repo and then step into this folder:

```bash
git clone https://github.com/crustyrustacean/ZTM-Build-Fest.git
cd ZTM-Build-Fest/projects/musicfeed
```

**Prerequisite:** a stable Rust toolchain. `rust-toolchain.toml` pins `stable`, and the crate is on the 2024 edition (needs Rust 1.85 or newer). If you have `rustup` it will fetch the pinned toolchain for you on the first build.

Start the server:

```bash
cargo run
```

Then open <http://127.0.0.1:8000>.

> **Run it from inside `projects/musicfeed`.** Tera loads `templates/**/*.html` and the config loader reads `configuration/`, both relative to the current working directory, so starting the binary from the repo root will panic on startup.

**Configuration** is layered: `configuration/base.toml` first, then `configuration/local.toml` (the default) or `configuration/production.toml`, then environment variables take final precedence.

| Variable | Effect | Default |
| --- | --- | --- |
| `APP_ENVIRONMENT` | Selects `local` or `production` | `local` |
| `APP_APPLICATION__HOST` | Bind address | `127.0.0.1` |
| `APP_APPLICATION__PORT` | Bind port | `8000` |

The `__` separator is how nested keys are addressed, so `APP_APPLICATION__PORT=8080` sets `application.port`:

```bash
APP_APPLICATION__PORT=8080 cargo run
```

### Running the Tests

```bash
cargo test
```

The integration tests boot the app on an ephemeral port and exercise the Datastar/SSE round trip, including the HTML-escaping guarantees. Set `TEST_LOG=1` to see application logs during the run.

### What's Next

The API will live in the web, deployed to `fly.io` — **nothing is provisioned there yet, so the app is local-only for now.** From there there will be a form for entering new albums/songs I've chosen to listen to at any given time. End users can then simply view my blog site and be presented with a real time update of what I'm listening to; they won't have to install or do anything other than that.