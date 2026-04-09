const cors = require("cors");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createCriticalRouteLogger } = require("../utils/logContext");

function setupBaseApp(app, { rootDir }) {
  app.set("trust proxy", 1);

  app.use(cors());
  app.use((req, res, next) => {
    const incoming = String(req.headers["x-request-id"] || "").trim();
    const requestId = incoming || (typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });
  app.use(express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      if (buf && buf.length) {
        req.rawBody = buf.toString("utf8");
      }
    }
  }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(createCriticalRouteLogger());
  app.use("/admin", express.static(path.join(rootDir, "public/admin")));
}

module.exports = {
  setupBaseApp,
};
