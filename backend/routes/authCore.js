const express = require("express");
const crypto = require("crypto");
const { isPremiumEntitled } = require("../utils/premiumEntitlement");

const { normalizePhoneNumber, isValidPhoneNumber, sanitizeString, normalizeCoordinates } = require("../utils/dataNormalization");

function createAuthCoreRouter({ User, Wallet, WorkerModel, bcrypt, jwt, jwtSecret, loginLimiter }) {
  const router = express.Router();

  router.post("/users/register", async (req, res) => {
    const allowedRoles = ["worker", "contractor", "admin"];
    let session;

    try {
      const {
        name,
        phone,
        password,
        role,
        agreedToTerms,
        termsVersion,
        latitude,
        longitude,
        fcmToken,
        deviceId,
        appVersion,
        termsHash,
      } = req.body;

      if (!name || !phone || !password || !role) {
        return res.status(400).json({ success: false, message: "All fields required" });
      }

      if (!isValidPhoneNumber(phone)) {
        return res.status(400).json({ success: false, message: "Phone number must be a valid 10-digit Indian number" });
      }

      const normalizedPhone = normalizePhoneNumber(phone);

      if (!allowedRoles.includes(role)) {
        return res.status(400).json({ success: false, message: "Invalid role provided" });
      }

      if (!agreedToTerms) {
        return res.status(400).json({ success: false, message: "Must agree to Terms and Conditions" });
      }

      if (!termsVersion || !termsHash) {
        return res.status(400).json({ success: false, message: "Terms version and terms hash are required when agreeing to terms" });
      }

      const existingUser = await User.findOne({ phone: normalizedPhone });
      if (existingUser) return res.status(400).json({ success: false, message: "Phone already registered" });

      const hashedPassword = await bcrypt.hash(password, 10);
      const cleanName = sanitizeString(name, 80);

      const newUser = new User({
        name: cleanName,
        phone: normalizedPhone,
        password: hashedPassword,
        role,
        agreedToTerms: true,
        agreedToTermsAt: new Date(),
        fcmToken: fcmToken || null,
        phoneVerified: false,
        location: { type: "Point", coordinates: [0, 0] },
      });

      session = await User.startSession();
      session.startTransaction();

      await newUser.save({ session });

      let wallet = await Wallet.findOne({ phone: normalizedPhone }).session(session);
      if (!wallet) {
        wallet = new Wallet({ phone: normalizedPhone });
        await wallet.save({ session });
      }

      if (role === "worker") {
        const existingWorker = await WorkerModel.findOne({ phone: normalizedPhone }).session(session);
        if (!existingWorker) {
          const newWorker = new WorkerModel({
            phone: normalizedPhone,
            skills: [],
            rating: 5,
            isAvailable: false,
            location: { type: "Point", coordinates: [0, 0] },
          });
          await newWorker.save({ session });
          console.log(`Worker record created for ${cleanName} (${normalizedPhone})`);
        }
      }

      try {
        const termsAudit = require("../utils/termsAudit");
        const auditResult = await termsAudit.logTermsAgreement(req, {
          phone: normalizedPhone,
          termsVersion,
          role,
          appVersion: appVersion || "unknown",
          deviceId: deviceId || "",
          termsHash,
        });

        if (!auditResult.success && auditResult.isDuplicate) {
          console.warn(`[Register] Duplicate terms agreement for ${normalizedPhone}, but proceeding with registration`);
        }
      } catch (termsErr) {
        console.error("[Register] Error logging terms agreement:", termsErr.message);
      }

      const accessToken = jwt.sign({ name: cleanName, phone: normalizedPhone, role }, jwtSecret, { expiresIn: "1h" });
      const refreshToken = crypto.randomBytes(40).toString("hex");
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      newUser.refreshTokens.push({ token: refreshToken, issuedAt: new Date(), expiresAt, deviceInfo: req.headers["user-agent"] || "unknown" });
      await newUser.save({ session });

      await session.commitTransaction();
      session.endSession();

      return res.json({ success: true, user: { name: cleanName, phone: normalizedPhone, role }, accessToken, refreshToken });
    } catch (err) {
      if (session) {
        try {
          await session.abortTransaction();
        } catch (abortErr) {
          console.error("Transaction abort failed:", abortErr.message);
        }
        session.endSession();
      }

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

      if (!isValidPhoneNumber(phone)) {
        return res.status(400).json({ success: false, message: "Phone number must be a valid 10-digit Indian number" });
      }

      const normalizedPhone = normalizePhoneNumber(phone);
      const user = await User.findOne({ phone: normalizedPhone });
      if (!user) return res.status(401).json({ success: false, message: "Invalid phone or password" });

      if (user.isBlocked) {
        return res.status(403).json({ success: false, message: "Account is blocked. Contact support." });
      }

      const requirePhoneVerification = process.env.ENFORCE_PHONE_VERIFICATION === 'true';
      if (requirePhoneVerification && user.phoneVerified === false) {
        return res.status(403).json({ success: false, message: "Phone number not verified. Please verify your account." });
      }

      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ success: false, message: "Invalid phone or password" });

      if (fcmToken) {
        user.fcmToken = fcmToken;
      }

      if ((latitude !== undefined && longitude === undefined) || (latitude === undefined && longitude !== undefined)) {
        return res.status(400).json({ success: false, message: "Both latitude and longitude are required for location updates." });
      }

      if (latitude !== undefined && longitude !== undefined) {
        const normalizedCoords = normalizeCoordinates(latitude, longitude);
        if (!normalizedCoords) {
          return res.status(400).json({ success: false, message: "Invalid latitude/longitude values" });
        }

        const { lat: parsedLat, lng: parsedLon } = normalizedCoords;
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

      const accessToken = jwt.sign({ name: user.name, phone: user.phone, role: user.role, id: user._id }, jwtSecret, { expiresIn: "1h" });
      const refreshToken = crypto.randomBytes(40).toString("hex");
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      user.refreshTokens = (user.refreshTokens || []).filter((rt) => rt.expiresAt && new Date(rt.expiresAt) > new Date());
      if (user.refreshTokens.length > 10) {
        user.refreshTokens = user.refreshTokens.slice(-10);
      }
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
          // ✅ FIXed: Validate premium status before including in response
          premiumPlan: user.premiumPlan && isPremiumEntitled(user) ? user.premiumPlan : { type: "free" },
          isAvailable: user.isAvailable || false,
        },
        accessToken,
        refreshToken,
      };

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

