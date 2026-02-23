const express = require("express");
const crypto = require("crypto");

function createAuthCoreRouter({ User, Wallet, WorkerModel, bcrypt, jwt, jwtSecret, loginLimiter }) {
  const router = express.Router();

  router.post("/users/register", async (req, res) => {
    try {
      const { name, phone, password, role, agreedToTerms, termsVersion, latitude, longitude, fcmToken, deviceId, appVersion, termsHash } = req.body;
      if (!name || !phone || !password || !role) {
        return res.status(400).json({ success: false, message: "All fields required" });
      }

      if (!password || password.length < 8) {
        return res.status(400).json({ success: false, message: "Password must be at least 8 characters long" });
      }
      if (!/\d/.test(password)) {
        return res.status(400).json({ success: false, message: "Password must contain at least one number" });
      }
      if (!/[A-Z]/.test(password)) {
        return res.status(400).json({ success: false, message: "Password must contain at least one uppercase letter" });
      }
      if (!/[a-z]/.test(password)) {
        return res.status(400).json({ success: false, message: "Password must contain at least one lowercase letter" });
      }

      if (!agreedToTerms) {
        return res.status(400).json({ success: false, message: "Must agree to Terms and Conditions" });
      }

      const existingUser = await User.findOne({ phone });
      if (existingUser) return res.status(400).json({ success: false, message: "Phone already registered" });

      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = new User({
        name,
        phone,
        password: hashedPassword,
        role,
        agreedToTerms: true,
        agreedToTermsAt: new Date(),
        fcmToken: fcmToken || null,
      });

      await newUser.save();

      let wallet = await Wallet.findOne({ phone });
      if (!wallet) {
        wallet = new Wallet({ phone });
        await wallet.save();
      }

      if (role === "worker") {
        const existingWorker = await WorkerModel.findOne({ phone });
        if (!existingWorker) {
          const newWorker = new WorkerModel({
            phone,
            skills: [],
            rating: 5,
            isAvailable: false,
            location: { type: "Point", coordinates: [0, 0] },
          });
          await newWorker.save();
          console.log(`Worker record created for ${name} (${phone})`);
        }
      }

      try {
        const termsAudit = require("../utils/termsAudit");
        const auditResult = await termsAudit.logTermsAgreement(req, {
          phone,
          termsVersion: termsVersion || "1.0",
          role,
          appVersion: appVersion || "unknown",
          deviceId: deviceId || "",
          termsHash: termsHash || "",
        });

        if (!auditResult.success && auditResult.isDuplicate) {
          console.warn(`[Register] Duplicate terms agreement for ${phone}, but proceeding with registration`);
        }
      } catch (termsErr) {
        console.error("[Register] Error logging terms agreement:", termsErr.message);
      }

      const accessToken = jwt.sign({ name, phone, role }, jwtSecret, { expiresIn: "1h" });
      const refreshToken = crypto.randomBytes(40).toString("hex");
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      newUser.refreshTokens.push({ token: refreshToken, issuedAt: new Date(), expiresAt, deviceInfo: req.headers["user-agent"] || "unknown" });
      await newUser.save();

      return res.json({ success: true, user: { name, phone, role }, accessToken, refreshToken });
    } catch (err) {
      if (err.code === 11000) {
        const field = Object.keys(err.keyPattern || {})[0];
        console.error(`E11000 Duplicate Key Error: ${field} already exists`, err.keyValue);
        return res.status(400).json({
          success: false,
          message: `${field} already registered. Please login instead.`,
        });
      }
      console.error("Register error", err.message || err);
      return res.status(500).json({ success: false, message: "Registration failed. Please try again." });
    }
  });

  router.post("/login", loginLimiter, async (req, res) => {
    try {
      const { phone, password, latitude, longitude, fcmToken } = req.body;
      if (!phone || !password) {
        return res.status(400).json({ success: false, message: "Phone and password required" });
      }
      const user = await User.findOne({ phone });
      if (!user) return res.status(401).json({ success: false, message: "Invalid phone or password" });

      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ success: false, message: "Invalid phone or password" });

      if (fcmToken) {
        user.fcmToken = fcmToken;
      }

      let cityLeaderboard = null;
      if (latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null) {
        try {
          const parsedLat = parseFloat(latitude);
          const parsedLon = parseFloat(longitude);

          if (isNaN(parsedLat) || isNaN(parsedLon)) {
            console.warn(`Invalid coordinates: lat=${latitude}, lon=${longitude}`);
          } else {
            const District = require("../models/City");
            const point = { type: "Point", coordinates: [parsedLon, parsedLat] };

            try {
              const districtCount = await District.countDocuments();
              if (districtCount === 0) {
                user.city = "Unknown";
                user.state = "Unknown";
              } else {
                let district = await District.findOne({
                  geometry: { $geoIntersects: { $geometry: point } },
                }).lean();

                if (!district) {
                  district = await District.findOne(
                    {
                      centroid: {
                        $nearSphere: {
                          $geometry: point,
                          $maxDistance: 50000,
                        },
                      },
                    },
                    null,
                    { lean: true }
                  );
                }

                if (district) {
                  user.city = district.name;
                  user.state = district.state;
                } else {
                  user.city = "Unknown";
                  user.state = "Unknown";
                }
              }
            } catch (distErr) {
              console.error("[Login] Error querying districts:", distErr.message);
              user.city = "Unknown";
              user.state = "Unknown";
            }

            user.latitude = parsedLat;
            user.longitude = parsedLon;
            user.location = {
              type: "Point",
              coordinates: [parsedLon, parsedLat],
            };
            user.locationLastUpdated = new Date();
            user.locationEnabled = true;

            try {
              await user.save();
            } catch (saveErr) {
              console.error("[Login] Error saving location:", saveErr.message);
            }
          }
        } catch (err) {
          console.error("Error finding district:", err.message);
        }
      }

      const accessToken = jwt.sign({ name: user.name, phone: user.phone, role: user.role, id: user._id }, jwtSecret, { expiresIn: "1h" });
      const refreshToken = crypto.randomBytes(40).toString("hex");
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      user.refreshTokens.push({ token: refreshToken, issuedAt: new Date(), expiresAt, deviceInfo: req.headers["user-agent"] || "unknown" });
      await user.save();

      let wallet = await Wallet.findOne({ phone: user.phone });
      if (!wallet) {
        wallet = new Wallet({ phone: user.phone });
        await wallet.save();
      }

      const response = {
        success: true,
        user: {
          _id: user._id,
          name: user.name,
          phone: user.phone,
          role: user.role,
          profilePhoto: user.profilePhoto,
          city: user.city,
          state: user.state,
          latitude: user.latitude,
          longitude: user.longitude,
          premiumPlan: user.premiumPlan,
          isAvailable: user.isAvailable || false,
        },
        accessToken,
        refreshToken,
      };

      if (cityLeaderboard) {
        response.leaderboard = cityLeaderboard;
      }

      return res.json(response);
    } catch (err) {
      console.error("Login error", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createAuthCoreRouter,
};

