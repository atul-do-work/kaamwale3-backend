async function connectDatabase({ mongoose, mongoUri, jobModel }) {
  const resolvedMongoUri = mongoUri || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/IndianWorker";

  await mongoose.connect(resolvedMongoUri, {
    maxPoolSize: 10, // Maintain up to 10 socket connections
    serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
    socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
    bufferCommands: false, // Disable mongoose buffering
    maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
    family: 4, // Use IPv4, skip trying IPv6
  });
  console.log("MongoDB Connected with connection pooling");

  try {
    const indexes = await jobModel.collection.getIndexes();
    if (indexes.id_1) {
      await jobModel.collection.dropIndex("id_1");
      console.log("Dropped old 'id' index from jobs collection");
    }
  } catch (err) {
    console.warn("Note: Could not drop old id index (may not exist):", err.message);
  }
}

module.exports = {
  connectDatabase,
};

