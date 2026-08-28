# Omnigent Voice

A minimal speech-only Discord interface for Omnigent. One process receives
Discord voice, transcribes it locally, sends the turn to Omnigent, adapts long
answers for speech when Celeris is configured, synthesizes speech locally, and
plays it back in the same voice channel.

The project is intentionally narrow: one caller, one active conversation, one
container, and no text or web interface.

## Development

Requires Node.js 22.12 or newer.

```bash
npm ci
npm run check
npm test
npm run dev
```

Copy `.env.example` to an untracked `.env` for local runs. Speech models are
downloaded separately and addressed through runtime paths; the container build
fetches pinned model artifacts itself.

## Container

```bash
podman build -t omnigent-voice:dev .
podman run --rm --env-file .env omnigent-voice:dev
```

The image has no embedded deployment configuration or credentials. See
`.env.example` for the runtime interface.

