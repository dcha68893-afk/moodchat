const fs = require('fs');
const path = require('path');

const modelMapping = {
  'user.model': './User',
  'message.model': './Message', 
  'chat.model': './Chat',
  'call.model': './Call',
  'group.model': './Group',
  'token.model': './Token',
  'status.model': './Status',
  'userStatus.model': './UserStatus',
  'groupInvite.model': './GroupInvite',
  'conversation.model': './Conversation',
  'profile.model': './Profile',
  'notification.model': './Notification',
  'readReceipt.model': './ReadReceipt',
  'mood.model': './Mood',
  'media.model': './Media'
};

function fixImports(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;
    
    // Fix model imports - SIMPLIFIED APPROACH
    for (const [oldName, newName] of Object.entries(modelMapping)) {
      // Handle require() statements
      const requirePattern1 = new RegExp(`require\\(['"]\\.\\./models/${oldName}['"]\\)`, 'g');
      const requirePattern2 = new RegExp(`require\\(['"]\\./${oldName}['"]\\)`, 'g');
      
      // Handle ES6 imports
      const importPattern1 = new RegExp(`from ['"]\\.\\./models/${oldName}['"]`, 'g');
      const importPattern2 = new RegExp(`from ['"]\\./${oldName}['"]`, 'g');
      
      if (requirePattern1.test(content)) {
        content = content.replace(requirePattern1, `require('../models/${newName.replace('./', '')}')`);
        changed = true;
      }
      
      if (requirePattern2.test(content)) {
        content = content.replace(requirePattern2, `require('./${newName.replace('./', '')}')`);
        changed = true;
      }
      
      if (importPattern1.test(content)) {
        content = content.replace(importPattern1, `from '../models/${newName.replace('./', '')}'`);
        changed = true;
      }
      
      if (importPattern2.test(content)) {
        content = content.replace(importPattern2, `from './${newName.replace('./', '')}'`);
        changed = true;
      }
    }
    
    // Fix auth.middleware import - SIMPLIFIED
    if (content.includes('auth.middleware')) {
      content = content.replace(/require\(['"]\.\.\/middleware\/auth\.middleware['"]\)/g, "require('../middleware/authMiddleware')");
      content = content.replace(/from ['"]\.\.\/middleware\/auth\.middleware['"]/g, "from '../middleware/authMiddleware'");
      changed = true;
    }
    
    // Fix errors import
    if (content.includes('../utils/errors')) {
      content = content.replace(/require\(['"]\.\.\/utils\/errors['"]\)/g, "require('../utils/errors')");
      changed = true;
    }
    
    // Fix WebSocketService typo
    if (content.includes('WebSorketService')) {
      content = content.replace(/WebSorketService/g, 'WebSocketService');
      changed = true;
    }
    
    // Fix typingService import
    if (content.includes('./typingService')) {
      content = content.replace(/require\(['"]\.\/typingService['"]\)/g, "require('./typingService')");
      content = content.replace(/from ['"]\.\/typingService['"]/g, "from './typingService'");
      changed = true;
    }
    
    if (changed) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`✅ Fixed: ${filePath}`);
    }
  } catch (error) {
    console.log(`❌ Error processing ${filePath}:`, error.message);
  }
}

// Find all JS files
function walkDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      
      // Skip node_modules and hidden directories
      if (stat.isDirectory() && !filePath.includes('node_modules') && !file.startsWith('.')) {
        walkDir(filePath);
      } else if (file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.ts') || file.endsWith('.tsx')) {
        fixImports(filePath);
      }
    }
  } catch (error) {
    console.log(`❌ Error walking directory ${dir}:`, error.message);
  }
}

console.log('🚀 Fixing imports...');
if (fs.existsSync('src')) {
  walkDir('src');
} else {
  console.log('❌ src directory not found!');
}
console.log('🎉 All imports fixed!');