const cors = require("cors");
const express = require("express");
const path = require("path");
const fs = require("fs").promises;

function setupBaseApp(app, { rootDir }) {
  app.set("trust proxy", 1);

  app.use(cors());
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

