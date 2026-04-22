const { Client } = require('pg');

async function checkFeaturesTable() {
  const client = new Client({
    host: 'dpg-d7k8hrl7vvec73969alg-a.virginia-postgres.render.com',
    port: 5432,
    database: 'moodchat',
    user: 'moodchat_user',
    password: '5CzyEV3lQZNgKruwJHOzA7bw8q6T72xD',
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Check features table structure
    const tableInfo = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'features' 
      ORDER BY ordinal_position
    `);
    
    console.log('Features table columns:');
    tableInfo.rows.forEach(row => {
      console.log(`- ${row.column_name}: ${row.data_type} (${row.is_nullable})`);
    });

    // Check if Users table exists
    const usersCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'Users'
      );
    `);
    console.log(`Users table exists: ${usersCheck.rows[0].exists}`);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

checkFeaturesTable();
