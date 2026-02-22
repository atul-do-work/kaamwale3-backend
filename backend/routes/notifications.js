const express = require("express");
const NotificationHistory = require("../models/NotificationHistory");
const { authenticateToken } = require("../utils/auth");

function createNotificationsRouter({ io }) {
  const router = express.Router();

  router.get("/notifications", authenticateToken, async (req, res) => {
    try {
      const { unreadOnly = false, limit = 50, skip = 0 } = req.query;
      const query = { recipientPhone: req.user.phone };

      if (unreadOnly === "true") {
        query.isRead = false;
      }

      const notifications = await NotificationHistory.find(query)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit, 10))
        .skip(parseInt(skip, 10));

      const total = await NotificationHistory.countDocuments(query);
      const unreadCount = await NotificationHistory.countDocuments({
        recipientPhone: req.user.phone,
        isRead: false,
      });

      return res.json({ success: true, notifications, total, unreadCount });
    } catch (err) {
      console.error("Fetch notifications error:", err);
      return res.status(500).json({ success: false, message: "Error fetching notifications" });
    }
  });

  router.put("/notifications/:id/read", authenticateToken, async (req, res) => {
    try {
      const notification = await NotificationHistory.findByIdAndUpdate(
        req.params.id,
        { isRead: true, readAt: new Date() },
        { new: true }
      );

      if (!notification) {
        return res.status(404).json({ success: false, message: "Notification not found" });
      }

      const unreadCount = await NotificationHistory.countDocuments({
        recipientPhone: req.user.phone,
        isRead: false,
      });

      io.emit("notificationCountUpdated", {
        recipientPhone: req.user.phone,
        unreadCount,
      });

      return res.json({ success: true, notification });
    } catch (err) {
      console.error("Mark notification read error:", err);
      return res.status(500).json({ success: false, message: "Error updating notification" });
    }
  });

  router.put("/notifications/read-all", authenticateToken, async (req, res) => {
    try {
      await NotificationHistory.updateMany(
        { recipientPhone: req.user.phone, isRead: false },
        { isRead: true, readAt: new Date() }
      );

      io.emit("notificationCountUpdated", {
        recipientPhone: req.user.phone,
        unreadCount: 0,
      });

      return res.json({ success: true, message: "All notifications marked as read" });
    } catch (err) {
      console.error("Mark all notifications read error:", err);
      return res.status(500).json({ success: false, message: "Error updating notifications" });
    }
  });

  return router;
}

module.exports = { createNotificationsRouter };
