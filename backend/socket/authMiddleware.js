function attachSocketAuthMiddleware(io, { jwt, jwtSecret, WorkerModel, User, connectedWorkers }) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake?.auth?.token;

      console.log(`Socket handshake - checking token... token=${token ? `present (${token.substring(0, 20)}...)` : "MISSING"}`);

      if (!token) {
        console.warn(`Socket ${socket.id} connecting WITHOUT token - DISCONNECTING`);
        socket.emit('auth_error', { message: 'Authentication required' });
        return socket.disconnect();
      }

      try {
        const user = jwt.verify(token, jwtSecret);
        socket.user = user;
        socket.data.user = user;
        console.log(`JWT verified for user: ${user.name} (${user.phone})`);

        if (user && user.phone) {
          try {
            const existing = await WorkerModel.findOne({ phone: user.phone });
            if (existing) {
              let mainSkill = null;
              let expectedWage = null;
              let isAvailable = false;
              try {
                const userRecord = await User.findOne({ phone: user.phone });
                if (userRecord) {
                  mainSkill = userRecord.mainSkill;
                  expectedWage = userRecord.expectedWage;
                  isAvailable = !!userRecord.isAvailable;
                }
              } catch (e) {
                console.error("Error fetching user mainSkill/expectedWage during reconnection:", e);
              }

              const persistedMainSkill = existing.mainSkill || mainSkill || (existing.skills && existing.skills[0]) || null;
              existing.socketId = socket.id;
              existing.mainSkill = persistedMainSkill;
              await existing.save();

              connectedWorkers.set(socket.id, {
                name: existing.phone || user.name,
                phone: existing.phone,
                lat: existing.location?.coordinates?.[1] || 0,
                lon: existing.location?.coordinates?.[0] || 0,
                workerType: existing.skills && existing.skills[0],
                mainSkill: persistedMainSkill,
                expectedWage,
                socketId: socket.id,
                isAvailable,
              });
              console.log(`Re-associated existing worker session for ${user.phone}`);
            }
          } catch (e) {
            console.error("Error re-associating worker session:", e);
          }
        }

        return next();
      } catch (err) {
        if (err.name === "TokenExpiredError") {
          console.warn("Socket connection with expired token - disconnecting client");
          socket.emit('tokenExpired', { message: 'Authentication token expired. Please refresh and reconnect.' });
          return socket.disconnect();
        }

        console.error(`Socket JWT verification FAILED: ${err && err.message}`);
        console.error(`   Error name: ${err?.name}`);
        console.error(`   Token sample: ${token ? `${token.substring(0, 30)}...` : "NO TOKEN PROVIDED"}`);
        return next();
      }
    } catch (e) {
      console.error("Socket auth middleware unexpected error:", e);
      return next();
    }
  });
}

module.exports = {
  attachSocketAuthMiddleware,
};
