const Worker = require("../models/Worker");

function socketHandler(io) {
  io.on("connection", (socket) => {
    console.log("Worker Connected:", socket.id);

    // Worker registering their live location
    socket.on("registerWorker", async ({ phone, lat, lon }) => {
      await Worker.findOneAndUpdate(
        { phone },
        {
          socketId: socket.id,
          location: { type: "Point", coordinates: [lon, lat] },
          isAvailable: true
        },
        { upsert: true }
      );
      console.log("Worker Registered:", phone, lat, lon);
    });

    socket.on("disconnect", async () => {
      await Worker.findOneAndUpdate(
        { socketId: socket.id },
        { isAvailable: false }
      );
      console.log("Worker disconnected:", socket.id);
    });
  });
}

module.exports = socketHandler;
