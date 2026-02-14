const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ===== CONFIG - UPDATE WITH YOUR CREDENTIALS =====
const API_BASE = process.env.BACKEND_URL || 'http://localhost:3000'; // Backend runs on port 3000
const PHONE = '9898298293'; // Your phone number (from signup)
const PASSWORD = '123456'; // Your password (from signup)
const GEOJSON_FILE = path.join(__dirname, '../GeoJson/GeoJson_cities.json');

// ===== FUNCTIONS =====

/**
 * Step 1: Get JWT token by logging in
 */
async function getAuthToken() {
  try {
    console.log('🔐 Logging in with credentials:');
    console.log(`   Phone: ${PHONE}`);
    console.log(`   API Base: ${API_BASE}`);
    
    const response = await axios.post(`${API_BASE}/login`, {
      phone: PHONE,
      password: PASSWORD,
    });

    if (!response.data.accessToken) {
      throw new Error('No token received from login');
    }

    console.log('✅ Login successful. Token received.');
    return response.data.accessToken;
  } catch (error) {
    console.error('❌ Login failed!');
    console.error('   Status:', error.response?.status);
    console.error('   Error:', error.response?.data || error.message);
    console.error('\n💡 TROUBLESHOOTING:');
    console.error('   1. Is backend running? (npm start in /backend)');
    console.error('   2. Check PHONE and PASSWORD in this script');
    console.error('   3. Verify user exists in MongoDB');
    process.exit(1);
  }
}

/**
 * Step 2: Load GeoJSON file
 */
function loadGeoJson() {
  try {
    console.log(`📂 Loading GeoJSON from: ${GEOJSON_FILE}`);
    const data = fs.readFileSync(GEOJSON_FILE, 'utf8');
    const geojson = JSON.parse(data);

    if (!geojson.features || !Array.isArray(geojson.features)) {
      throw new Error('Invalid GeoJSON: missing features array');
    }

    console.log(`✅ Loaded ${geojson.features.length} features from GeoJSON`);
    return geojson;
  } catch (error) {
    console.error('❌ Failed to load GeoJSON:', error.message);
    process.exit(1);
  }
}

/**
 * Step 3: Upload GeoJSON to backend
 */
async function uploadDistricts(token, geojson) {
  try {
    console.log('📤 Uploading districts to backend...');
    const response = await axios.post(
      `${API_BASE}/admin/districts/import-geojson`,
      geojson,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = response.data;

    console.log('\n✅ IMPORT COMPLETE!');
    console.log(`   Imported: ${result.importedDistricts || 0} districts`);
    console.log(`   Total: ${result.count || 0} districts in MongoDB`);

    if (result.errors && result.errors.length > 0) {
      console.log(`\n⚠️  ${result.errors.length} errors encountered:`);
      result.errors.slice(0, 5).forEach((err) => {
        console.log(`   - ${err}`);
      });
      if (result.errors.length > 5) {
        console.log(`   ... and ${result.errors.length - 5} more`);
      }
    }

    return result;
  } catch (error) {
    console.error('❌ Upload failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

/**
 * Test backend connection
 */
async function testConnection() {
  try {
    console.log('🔗 Testing backend connection at:', API_BASE);
    await axios.get(`${API_BASE}/`, { timeout: 5000 }).catch(() => null);
    console.log('✅ Backend is reachable!\n');
  } catch (error) {
    console.error('❌ Cannot reach backend at:', API_BASE);
    console.error('💡 Troubleshooting:');
    console.error('   1. Is backend running? Run: npm start (in /backend folder)');
    console.error('   2. Check API_BASE in this script (should be http://localhost:3000)');
    console.error('   3. Error details:', error.message);
    process.exit(1);
  }
}

/**
 * Main function: Run all steps
 */
async function main() {
  console.log('\n=====================================');
  console.log('  KAAMWALE3 - DISTRICT IMPORTER');
  console.log('=====================================\n');

  // Pre-Check: Test connection
  await testConnection();

  // Step 1: Authenticate
  const token = await getAuthToken();

  // Step 2: Load GeoJSON
  const geojson = loadGeoJson();

  // Step 3: Upload
  await uploadDistricts(token, geojson);

  console.log('\n✨ All done! Districts are now in MongoDB.\n');
  process.exit(0);
}

main();
