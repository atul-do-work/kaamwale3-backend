const cors = require("cors");
const express = require("express");
const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");

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
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  app.use("/uploads", express.static(path.join(rootDir, "uploads")));
  app.use("/admin", express.static(path.join(rootDir, "public/admin")));

  const uploadsDir = path.join(rootDir, "uploads");
  fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);
}

module.exports = {
  setupBaseApp,
};
