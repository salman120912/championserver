import { compare } from 'bcrypt';
import User from './src/models/User';
import sequelize from './src/config/database';

async function checkUserPasswords() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established.');

    // Get all users
    const users = await User.findAll({
      attributes: ['id', 'email', 'password', 'positionType']
    });

    console.log(`\n📊 Found ${users.length} users in database:`);
    
    for (const user of users) {
      console.log(`\n👤 User: ${user.email}`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Password hash: ${user.password ? '✅ Present' : '❌ Missing'}`);
      console.log(`   Password length: ${user.password?.length || 0}`);
      console.log(`   PositionType: ${user.positionType || '❌ Not set'}`);
      
      // Test password comparison with a known password
      if (user.password) {
        const testPassword = 'password123';
        try {
          const isMatch = await compare(testPassword, user.password);
          console.log(`   Test password 'password123' match: ${isMatch ? '✅ Yes' : '❌ No'}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          console.log(`   ❌ Password comparison error:`, errorMessage);
        }
      }
    }

    // Check if positionType column exists
    const [results] = await sequelize.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'positionType'
    `);
    
    console.log(`\n🗄️ Database schema check:`);
    if (results.length > 0) {
      console.log('✅ positionType column exists in database');
    } else {
      console.log('❌ positionType column does not exist in database');
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('❌ Error:', errorMessage);
  } finally {
    await sequelize.close();
  }
}

checkUserPasswords(); 