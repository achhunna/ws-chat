# ws-test

Small realtime telemetry demo with:

- Node + Express server
- Chat page at `/chat`
- SQLite-backed chat history
- JSON history endpoint at `/api/chat/history`
- React websocket chat client

## Run

```bash
npm install
npm run dev
```

Open `http://localhost/chat`.

## History

```bash
curl http://localhost/api/chat/history
```

## Clear

```bash
curl -X DELETE http://localhost/api/chat/history
```
