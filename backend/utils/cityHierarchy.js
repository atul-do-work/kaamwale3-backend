/**
 * City Hierarchy Mapping
 * Maps smaller locations (villages, towns, talukas) to parent cities
 * This ensures leaderboard is organized by major cities, not every small town
 */

const CITY_HIERARCHY = {
  // Pune District
  "mulshi": { parent_city: "pune", parent_state: "maharashtra", region: "west" },
  "hinjewadi": { parent_city: "pune", parent_state: "maharashtra", region: "west" },
  "undri": { parent_city: "pune", parent_state: "maharashtra", region: "south" },
  "pcmc": { parent_city: "pune", parent_state: "maharashtra", region: "north" },
  "pimpri": { parent_city: "pune", parent_state: "maharashtra", region: "north" },
  "chinchwad": { parent_city: "pune", parent_state: "maharashtra", region: "north" },
  "baner": { parent_city: "pune", parent_state: "maharashtra", region: "west" },
  "viman nagar": { parent_city: "pune", parent_state: "maharashtra", region: "east" },
  "kharadi": { parent_city: "pune", parent_state: "maharashtra", region: "east" },
  "wakad": { parent_city: "pune", parent_state: "maharashtra", region: "north" },
  "hadapsar": { parent_city: "pune", parent_state: "maharashtra", region: "south" },
  "kondhwa": { parent_city: "pune", parent_state: "maharashtra", region: "south" },
  "ravet": { parent_city: "pune", parent_state: "maharashtra", region: "north" },
  "talegaon dabhade": { parent_city: "pune", parent_state: "maharashtra", region: "west" },
  "jejuri": { parent_city: "pune", parent_state: "maharashtra", region: "south" },
  
  // Mumbai Metropolitan Area
  "navi mumbai": { parent_city: "mumbai", parent_state: "maharashtra", region: "south" },
  "thane": { parent_city: "mumbai", parent_state: "maharashtra", region: "east" },
  "kalyan": { parent_city: "mumbai", parent_state: "maharashtra", region: "east" },
  "dombivli": { parent_city: "mumbai", parent_state: "maharashtra", region: "east" },
  "vasai": { parent_city: "mumbai", parent_state: "maharashtra", region: "north" },
  "virar": { parent_city: "mumbai", parent_state: "maharashtra", region: "north" },
  "raigad": { parent_city: "mumbai", parent_state: "maharashtra", region: "south" },
  "panvel": { parent_city: "mumbai", parent_state: "maharashtra", region: "south" },
  
  // Nagpur District
  "nagpur": { parent_city: "nagpur", parent_state: "maharashtra", region: "central" },
  "wardha": { parent_city: "nagpur", parent_state: "maharashtra", region: "central" },
  "bhandara": { parent_city: "nagpur", parent_state: "maharashtra", region: "central" },
  
  // Nashik District
  "nashik": { parent_city: "nashik", parent_state: "maharashtra", region: "north" },
  "malegaon": { parent_city: "nashik", parent_state: "maharashtra", region: "north" },
  
  // Aurangabad District
  "aurangabad": { parent_city: "aurangabad", parent_state: "maharashtra", region: "central" },
  "paithan": { parent_city: "aurangabad", parent_state: "maharashtra", region: "central" },
  
  // Kolhapur District
  "kolhapur": { parent_city: "kolhapur", parent_state: "maharashtra", region: "south" },
  
  // Satara District
  "satara": { parent_city: "satara", parent_state: "maharashtra", region: "south" },
  
  // Solapur District
  "solapur": { parent_city: "solapur", parent_state: "maharashtra", region: "south" },
  
  // Sangli District
  "sangli": { parent_city: "sangli", parent_state: "maharashtra", region: "south" },
  
  // Bengaluru (Karnataka)
  "whitefield": { parent_city: "bengaluru", parent_state: "karnataka", region: "east" },
  "indiranagar": { parent_city: "bengaluru", parent_state: "karnataka", region: "east" },
  "koramangala": { parent_city: "bengaluru", parent_state: "karnataka", region: "south" },
  "marathahalli": { parent_city: "bengaluru", parent_state: "karnataka", region: "east" },
  "bellandur": { parent_city: "bengaluru", parent_state: "karnataka", region: "south" },
  "sarjapur": { parent_city: "bengaluru", parent_state: "karnataka", region: "south" },
  "ulsoor": { parent_city: "bengaluru", parent_state: "karnataka", region: "central" },
  "mcal": { parent_city: "bengaluru", parent_state: "karnataka", region: "west" },
  "jayanagar": { parent_city: "bengaluru", parent_state: "karnataka", region: "south" },
  "jp nagar": { parent_city: "bengaluru", parent_state: "karnataka", region: "south" },
  
  // Delhi NCR
  "gurgaon": { parent_city: "delhi", parent_state: "delhi", region: "south" },
  "noida": { parent_city: "delhi", parent_state: "delhi", region: "east" },
  "greater noida": { parent_city: "delhi", parent_state: "delhi", region: "east" },
  "faridabad": { parent_city: "delhi", parent_state: "delhi", region: "east" },
  "ghaziabad": { parent_city: "delhi", parent_state: "delhi", region: "east" },
  
  // Hyderabad
  "secunderabad": { parent_city: "hyderabad", parent_state: "telangana", region: "north" },
  "cyberabad": { parent_city: "hyderabad", parent_state: "telangana", region: "west" },
  
  // Ahmedabad
  "gandhinagar": { parent_city: "ahmedabad", parent_state: "gujarat", region: "north" },
};

/**
 * Normalize location to parent city
 * Takes a detected location and maps it to major city if applicable
 */
function normalizeLocation(detectedCity, detectedState) {
  const normalizedCity = detectedCity.toLowerCase().trim();
  const normalizedState = detectedState.toLowerCase().trim();

  // Check if this location has a parent city mapping
  if (CITY_HIERARCHY[normalizedCity]) {
    const mapping = CITY_HIERARCHY[normalizedCity];
    return {
      city: mapping.parent_city,
      state: mapping.parent_state,
      region: mapping.region,
      originalLocation: normalizedCity, // Keep track of original for reference
      isMapped: true,
    };
  }

  // If no mapping, return as-is (it's already a major city)
  return {
    city: normalizedCity,
    state: normalizedState,
    region: null,
    originalLocation: null,
    isMapped: false,
  };
}

/**
 * Get all sub-locations of a city
 * Useful for analytics or debugging
 */
function getSubLocations(cityName) {
  const locations = [];
  const normalizedCity = cityName.toLowerCase();

  for (const [location, mapping] of Object.entries(CITY_HIERARCHY)) {
    if (mapping.parent_city === normalizedCity) {
      locations.push({
        location,
        region: mapping.region,
      });
    }
  }

  return locations;
}

module.exports = {
  CITY_HIERARCHY,
  normalizeLocation,
  getSubLocations,
};
