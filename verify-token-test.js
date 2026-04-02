const jwt = require('jsonwebtoken');
require('dotenv').config();

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjExLCJpZCI6MTEsImVtYWlsIjpudWxsLCJ1c2VybmFtZSI6bnVsbCwicm9sZSI6InVzZXIiLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNzc0NTU0ODQ3LCJleHAiOjE3NzQ2NDEyNDd9.ZRGYEdd_utbbtMcSGD_eS85bKfZezm2bQr9-9EfCwsI';
const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;

console.log('Testing token verification...');
console.log('JWT_SECRET from .env:', JWT_SECRET);
console.log('JWT_SECRET length:', JWT_SECRET ? JWT_SECRET.length : 0);
console.log('Token:', token.substring(0, 50) + '...');

try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('\n? SUCCESS: Token verified!');
    console.log('Decoded payload:', decoded);
} catch (error) {
    console.log('\n? FAILED: Token verification error');
    console.log('Error:', error.message);
    console.log('Error name:', error.name);
    
    // Try to decode without verification to see the payload
    try {
        const decodedNoVerify = jwt.decode(token);
        console.log('\nDecoded without verification:', decodedNoVerify);
    } catch (e) {
        console.log('Could not decode:', e.message);
    }
}
