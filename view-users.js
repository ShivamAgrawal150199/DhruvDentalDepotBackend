const sqlite3 = require('sqlite3');
const path = require('path');

// Open database
const dbPath = path.join(__dirname, 'data', 'app.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }
});

console.log('\n======================================');
console.log('     DHRUV DENTAL DEPOT - USERS');
console.log('======================================\n');

// Get all users
db.all('SELECT id, name, email, created_at FROM users ORDER BY created_at DESC', (err, users) => {
  if (err) {
    console.error('Error fetching users:', err.message);
    db.close();
    process.exit(1);
  }

  if (users.length === 0) {
    console.log('No users registered yet.\n');
  } else {
    console.log(`Total Registered Users: ${users.length}\n`);
    console.log('─'.repeat(80));

    users.forEach((user, index) => {
      console.log(`\n${index + 1}. Name: ${user.name}`);
      console.log(`   Email: ${user.email}`);
      console.log(`   User ID: ${user.id}`);
      console.log(`   Registered: ${user.created_at}`);
    });

    console.log('\n' + '─'.repeat(80));
    console.log(`\nTotal Users: ${users.length}\n`);
  }

  // Close database
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
      process.exit(1);
    }
  });
});
