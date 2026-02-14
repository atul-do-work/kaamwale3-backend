const mongoose = require("mongoose");

const districtSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true }, // District name (e.g., "Adilabad")
    slug: { type: String, required: true, unique: true, lowercase: true }, // URL-safe name
    state: { type: String, required: true }, // State name (e.g., "Andhra Pradesh")
    properties: {
      stateCensuscode: { type: Number }, // ST_CEN_CD
      districtCensuscode: { type: Number }, // DT_CEN_CD
      censuscode: { type: Number }, // Overall census code
    },
    // GeoJSON Polygon or MultiPolygon
    geometry: {
      type: { type: String, enum: ["Polygon", "MultiPolygon"], required: true },
      coordinates: { type: mongoose.Schema.Types.Mixed, required: true },
    },
    // Centroid for fallback nearest city lookup
    centroid: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true }, // [lon, lat]
    },
    // Bounding box for pre-filter optimization
    bbox: {
      minLon: Number,
      maxLon: Number,
      minLat: Number,
      maxLat: Number,
    },
  },
  { timestamps: true } // Automatically creates createdAt & updatedAt with auto-update
);

// ✅ GeoJSON Validation (pre-save hook)
districtSchema.pre("save", function (next) {
  try {
    const { geometry, centroid } = this;

    // ✅ Validate geometry
    if (!geometry || !geometry.type || !geometry.coordinates) {
      throw new Error("Invalid geometry: Missing type or coordinates");
    }

    if (!["Polygon", "MultiPolygon"].includes(geometry.type)) {
      throw new Error(
        `Invalid geometry type: ${geometry.type}. Must be Polygon or MultiPolygon`
      );
    }

    // ✅ Validate polygon closure (for both Polygon and MultiPolygon)
    const validatePolygonClosure = (coords) => {
      if (coords.length < 4) {
        throw new Error(
          "Polygon must have at least 4 coordinates (including closed ring)"
        );
      }
      const first = coords[0];
      const last = coords[coords.length - 1];

      if (
        first[0] !== last[0] || first[1] !== last[1]
      ) {
        throw new Error(
          `Polygon not closed: first [${first[0]}, ${first[1]}] != last [${last[0]}, ${last[1]}]`
        );
      }
    };

    if (geometry.type === "Polygon") {
      // coords = [[[lon, lat], [lon, lat], ...]]
      geometry.coordinates.forEach((ring, ringIndex) => {
        validatePolygonClosure(ring);
      });
    } else if (geometry.type === "MultiPolygon") {
      // coords = [[[[lon, lat], ...]], [[[lon, lat], ...]]]
      geometry.coordinates.forEach((polygon, polygonIndex) => {
        polygon.forEach((ring, ringIndex) => {
          validatePolygonClosure(ring);
        });
      });
    }

    // ✅ Validate centroid
    if (!centroid || centroid.type !== "Point") {
      throw new Error("Invalid centroid: Must be type Point");
    }

    if (
      !Array.isArray(centroid.coordinates) ||
      centroid.coordinates.length !== 2 ||
      typeof centroid.coordinates[0] !== "number" ||
      typeof centroid.coordinates[1] !== "number"
    ) {
      throw new Error(
        "Invalid centroid coordinates: Must be [lon, lat] with valid numbers"
      );
    }

    // ✅ Validate centroid is within bounds
    const [lon, lat] = centroid.coordinates;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      throw new Error(
        `Invalid centroid coordinates: lon=${lon} must be -180 to 180, lat=${lat} must be -90 to 90`
      );
    }

    next();
  } catch (error) {
    next(new Error(`GeoJSON validation failed: ${error.message}`));
  }
});

// ✅ Indexes for geospatial and text queries
// 2dsphere index on geometry for $geoIntersects queries (point-in-polygon)
districtSchema.index({ geometry: "2dsphere" });
// Index on centroid for $nearSphere fallback (find nearest district)
districtSchema.index({ centroid: "2dsphere" });
// Text index for district name and state search
districtSchema.index({ name: "text", slug: "text", state: "text" });

module.exports = mongoose.model("District", districtSchema);
