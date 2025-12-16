const mongoose = require('mongoose');
const User = require('./models/User');
const CityLeaderboard = require('./models/CityLeaderboard');

mongoose.connect('mongodb://127.0.0.1:27017/kaamwale').then(async () => {
  try {
    console.log('🔧 Starting cleanup...\n');

    // Update all contractors with mulshi to pune
    const result = await User.updateMany(
      { role: 'contractor', city: 'mulshi' },
      { city: 'pune', state: 'maharashtra' }
    );
    console.log('✅ Updated contractors:', result.modifiedCount);

    // Delete old leaderboards
    const delResult = await CityLeaderboard.deleteMany({});
    console.log('✅ Deleted leaderboards:', delResult.deletedCount);

    // Show all contractors
    const contractors = await User.find({ role: 'contractor' }, 'phone name city state');
    console.log('\n📋 All contractors after cleanup:');
    contractors.forEach(c => console.log(`   ${c.phone} - ${c.name} - ${c.city}, ${c.state}`));

    console.log('\n✅ Cleanup complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
});
