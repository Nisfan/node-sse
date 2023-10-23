import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import EventEmitter from "events";
import cookieParser from "cookie-parser";

const app = express();

app.use(cors());
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = 3001;

const stream = new EventEmitter();

app.listen(PORT, () => {
  console.log(`Events service listening at http://localhost:${PORT}`);
});

function eventsHandler(request, response, next) {
  const headers = {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-cache,no-transform",
  };

  response.writeHead(200, headers);

  const encoder = new TextEncoder();
  stream.on("channel", function (event, data) {
    //res.write(JSON.stringify({ counter: data })); // NOTE: this DOES NOT work
    console.log("event", event);
    console.log("event.data", data);

    response.write(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  });

  const clientId = Date.now();

  request.on("close", () => {
    console.log(`${clientId} Connection closed`);
    response.end();
  });
}

function postHandler(request, response, next) {
  console.log("Cookies: ", request.cookies);
  const payload = request.body;
  console.log("payload", payload);
  stream.emit("channel", payload.sessionId, payload);
  response.json(payload);
}

app.get("/api/sse", eventsHandler);
app.post("/api/sse", postHandler);
