/**
 * City Hierarchy Mapping
 * Maps smaller locations (villages, towns, talukas) to parent cities
 * This ensures leaderboard is organized by major cities, not every small town
 */

const CITY_HIERARCHY = {
  // ===== RAJASTHAN - Jaipur District =====
  "amber tehsil": { parent_city: "jaipur", parent_state: "rajasthan", region: "north" },
  "jamwa ramgarh tehsil": { parent_city: "jaipur", parent_state: "rajasthan", region: "south" },
  "amber": { parent_city: "jaipur", parent_state: "rajasthan", region: "north" },
  "jamwa": { parent_city: "jaipur", parent_state: "rajasthan", region: "south" },
  "jamwa ramgarh": { parent_city: "jaipur", parent_state: "rajasthan", region: "south" },
  "ghat ki guni": { parent_city: "jaipur", parent_state: "rajasthan", region: "east" },
  "phool mahal": { parent_city: "jaipur", parent_state: "rajasthan", region: "west" },
  "sanganer": { parent_city: "jaipur", parent_state: "rajasthan", region: "south" },
  "bassi": { parent_city: "jaipur", parent_state: "rajasthan", region: "south" },
  "chaksu": { parent_city: "jaipur", parent_state: "rajasthan", region: "southwest" },
  "dudu": { parent_city: "jaipur", parent_state: "rajasthan", region: "south" },
  "kalkho": { parent_city: "jaipur", parent_state: "rajasthan", region: "southwest" },
  "kotputli": { parent_city: "jaipur", parent_state: "rajasthan", region: "northwest" },
  "mahwa": { parent_city: "jaipur", parent_state: "rajasthan", region: "north" },
  "phagi": { parent_city: "jaipur", parent_state: "rajasthan", region: "west" },
  "amer": { parent_city: "jaipur", parent_state: "rajasthan", region: "north" },
  
  // ===== RAJASTHAN - Other Major Cities =====
  "jodhpur": { parent_city: "jodhpur", parent_state: "rajasthan", region: "west" },
  "udaipur": { parent_city: "udaipur", parent_state: "rajasthan", region: "south" },
  "ajmer": { parent_city: "ajmer", parent_state: "rajasthan", region: "central" },
  "bikaner": { parent_city: "bikaner", parent_state: "rajasthan", region: "northwest" },
  "kota": { parent_city: "kota", parent_state: "rajasthan", region: "southeast" },
  "alwar": { parent_city: "alwar", parent_state: "rajasthan", region: "northeast" },
  "bhilwara": { parent_city: "bhilwara", parent_state: "rajasthan", region: "central" },
  "nagaur": { parent_city: "nagaur", parent_state: "rajasthan", region: "west" },
  "sikar": { parent_city: "sikar", parent_state: "rajasthan", region: "north" },
  "jhunjhunu": { parent_city: "jhunjhunu", parent_state: "rajasthan", region: "north" },
  
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
 * Returns null for unknown/invalid locations
 */
function normalizeLocation(detectedCity, detectedState) {
  if (!detectedCity || !detectedState) return null;
  
  const normalizedCity = String(detectedCity).toLowerCase().trim();
  const normalizedState = String(detectedState).toLowerCase().trim();

  // ✅ REJECT "Unknown" - return null so invalid locations are not stored
  if (normalizedCity === 'unknown' || normalizedState === 'unknown') {
    console.warn(`⚠️ Rejecting unknown location: city="${detectedCity}", state="${detectedState}"`);
    return null;
  }

  // Check if this location has a parent city mapping
  if (CITY_HIERARCHY[normalizedCity]) {
    const mapping = CITY_HIERARCHY[normalizedCity];
    return {
      city: mapping.parent_city,
      state: mapping.parent_state,
      region: mapping.region,
      originalLocation: normalizedCity,
      isMapped: true,
    };
  }

  // If no mapping, check if it's already a major city (ends with typical city/state names or common city markers)
  // Return as-is for major cities, null for likely small towns/villages without explicit mapping
  const majorCities = [
    'pune', 'mumbai', 'jaipur', 'jodhpur', 'udaipur', 'ajmer', 'bikaner', 'kota', 'alwar', 'bhilwara', 'nagaur', 'sikar', 'jhunjhunu',
    'nagpur', 'nashik', 'aurangabad', 'kolhapur', 'satara', 'solapur', 'sangli',
    'bengaluru', 'delhi', 'hyderabad', 'ahmedabad', 'indore', 'bhopal', 'lucknow', 'chandigarh'
  ];
  
  if (majorCities.includes(normalizedCity)) {
    return {
      city: normalizedCity,
      state: normalizedState,
      region: null,
      originalLocation: null,
      isMapped: false,
    };
  }

  // For unmapped smaller locations, return null instead of storing them as separate city entries
  // This prevents fragmentation of leaderboards
  console.warn(`ℹ️ Unmapped location not in hierarchy: "${detectedCity}", "${detectedState}"`);
  return null;
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
