const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { User, FeatureFlag, UserFeaturePreference, Chat, Group } = require('../models');
const { Op } = require('sequelize');

router.use(authenticateToken);

console.log('✅ Features routes initialized');

// Get all available features with user preferences
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;

      const [features, userPreferences] = await Promise.all([
        FeatureFlag.findAll({
          where: {
            isActive: true
          },
          order: [['category', 'ASC'], ['name', 'ASC']]
        }),
        UserFeaturePreference.findAll({
          where: { userId },
          include: [{
            model: FeatureFlag,
            attributes: ['name', 'category', 'description']
          }]
        })
      ]);

      // Merge features with user preferences
      const featuresWithPreferences = features.map(feature => {
        const preference = userPreferences.find(p => p.featureId === feature.id);
        const featureObj = feature.toJSON();
        
        return {
          ...featureObj,
          enabled: preference ? preference.enabled : feature.defaultEnabled,
          userPreferenceId: preference ? preference.id : null,
          settings: preference ? preference.settings : {}
        };
      });

      // Group by category
      const groupedFeatures = {};
      featuresWithPreferences.forEach(feature => {
        if (!groupedFeatures[feature.category]) {
          groupedFeatures[feature.category] = [];
        }
        groupedFeatures[feature.category].push(feature);
      });

      res.status(200).json({
        status: 'success',
        data: {
          features: groupedFeatures,
          lastUpdated: new Date()
        }
      });
    } catch (error) {
      console.error('Error getting features:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch features'
      });
    }
  })
);

// Toggle feature for user
router.post(
  '/:featureId/toggle',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { featureId } = req.params;
      const { enabled, settings } = req.body;

      const feature = await FeatureFlag.findByPk(featureId);
      
      if (!feature) {
        return res.status(404).json({
          status: 'error',
          message: 'Feature not found'
        });
      }

      if (!feature.isActive) {
        return res.status(400).json({
          status: 'error',
          message: 'Feature is not available'
        });
      }

      // Check if user has access to this feature based on plan
      const user = await User.findByPk(userId);
      const userPlan = user.plan || 'free';
      
      if (feature.requiredPlan && feature.requiredPlan !== userPlan) {
        const planHierarchy = ['free', 'pro', 'enterprise'];
        const userPlanIndex = planHierarchy.indexOf(userPlan);
        const requiredPlanIndex = planHierarchy.indexOf(feature.requiredPlan);
        
        if (userPlanIndex < requiredPlanIndex) {
          return res.status(403).json({
            status: 'error',
            message: `This feature requires ${feature.requiredPlan} plan`
          });
        }
      }

      const [preference, created] = await UserFeaturePreference.findOrCreate({
        where: { userId, featureId },
        defaults: {
          userId,
          featureId,
          enabled: enabled !== undefined ? enabled : !feature.defaultEnabled,
          settings: settings || {}
        }
      });

      if (!created) {
        const updateData = {};
        if (enabled !== undefined) updateData.enabled = enabled;
        if (settings !== undefined) updateData.settings = settings;
        
        await preference.update(updateData);
      }

      res.status(200).json({
        status: 'success',
        message: `Feature ${preference.enabled ? 'enabled' : 'disabled'}`,
        data: {
          featureId: feature.id,
          featureName: feature.name,
          enabled: preference.enabled,
          settings: preference.settings
        }
      });
    } catch (error) {
      console.error('Error toggling feature:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to toggle feature'
      });
    }
  })
);

// Get user's feature preferences
router.get(
  '/preferences',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;

      const preferences = await UserFeaturePreference.findAll({
        where: { userId },
        include: [{
          model: FeatureFlag,
          attributes: ['name', 'category', 'description', 'version', 'requiredPlan']
        }],
        order: [[FeatureFlag, 'category', 'ASC']]
      });

      res.status(200).json({
        status: 'success',
        data: {
          preferences: preferences.map(p => ({
            id: p.id,
            featureId: p.featureId,
            featureName: p.FeatureFlag.name,
            category: p.FeatureFlag.category,
            enabled: p.enabled,
            settings: p.settings,
            lastModified: p.updatedAt
          })),
          count: preferences.length
        }
      });
    } catch (error) {
      console.error('Error getting feature preferences:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch feature preferences'
      });
    }
  })
);

// Get feature-specific settings
router.get(
  '/:featureName/settings',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { featureName } = req.params;

      const feature = await FeatureFlag.findOne({
        where: { 
          name: featureName,
          isActive: true
        }
      });

      if (!feature) {
        return res.status(404).json({
          status: 'error',
          message: 'Feature not found'
        });
      }

      const preference = await UserFeaturePreference.findOne({
        where: { userId, featureId: feature.id },
        include: [{
          model: FeatureFlag,
          attributes: ['name', 'category', 'description', 'defaultSettings']
        }]
      });

      const featureData = feature.toJSON();
      const settings = preference ? preference.settings : featureData.defaultSettings || {};

      res.status(200).json({
        status: 'success',
        data: {
          feature: {
            id: feature.id,
            name: feature.name,
            category: feature.category,
            description: feature.description,
            version: feature.version
          },
          enabled: preference ? preference.enabled : feature.defaultEnabled,
          settings: settings,
          isCustomized: !!preference
        }
      });
    } catch (error) {
      console.error('Error getting feature settings:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch feature settings'
      });
    }
  })
);

// Update feature-specific settings
router.put(
  '/:featureName/settings',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { featureName } = req.params;
      const { settings, enabled } = req.body;

      const feature = await FeatureFlag.findOne({
        where: { 
          name: featureName,
          isActive: true
        }
      });

      if (!feature) {
        return res.status(404).json({
          status: 'error',
          message: 'Feature not found'
        });
      }

      const [preference, created] = await UserFeaturePreference.findOrCreate({
        where: { userId, featureId: feature.id },
        defaults: {
          userId,
          featureId: feature.id,
          enabled: enabled !== undefined ? enabled : feature.defaultEnabled,
          settings: settings || {}
        }
      });

      if (!created) {
        const updateData = {};
        if (settings !== undefined) updateData.settings = settings;
        if (enabled !== undefined) updateData.enabled = enabled;
        
        await preference.update(updateData);
      }

      res.status(200).json({
        status: 'success',
        message: 'Feature settings updated',
        data: {
          featureId: feature.id,
          featureName: feature.name,
          enabled: preference.enabled,
          settings: preference.settings
        }
      });
    } catch (error) {
      console.error('Error updating feature settings:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update feature settings'
      });
    }
  })
);

// Get available themes
router.get(
  '/themes',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const themes = [
        {
          id: 'light',
          name: 'Light',
          description: 'Bright theme for daytime use',
          primaryColor: '#3b82f6',
          backgroundColor: '#ffffff',
          textColor: '#1f2937',
          isDark: false
        },
        {
          id: 'dark',
          name: 'Dark',
          description: 'Dark theme for nighttime use',
          primaryColor: '#60a5fa',
          backgroundColor: '#111827',
          textColor: '#f9fafb',
          isDark: true
        },
        {
          id: 'blue',
          name: 'Ocean Blue',
          description: 'Blue themed interface',
          primaryColor: '#0ea5e9',
          backgroundColor: '#f0f9ff',
          textColor: '#0c4a6e',
          isDark: false
        },
        {
          id: 'purple',
          name: 'Royal Purple',
          description: 'Purple themed interface',
          primaryColor: '#8b5cf6',
          backgroundColor: '#faf5ff',
          textColor: '#5b21b6',
          isDark: false
        },
        {
          id: 'green',
          name: 'Forest Green',
          description: 'Green themed interface',
          primaryColor: '#10b981',
          backgroundColor: '#f0fdf4',
          textColor: '#065f46',
          isDark: false
        },
        {
          id: 'midnight',
          name: 'Midnight',
          description: 'Ultra dark theme',
          primaryColor: '#818cf8',
          backgroundColor: '#000000',
          textColor: '#e5e7eb',
          isDark: true
        }
      ];

      res.status(200).json({
        status: 'success',
        data: {
          themes,
          currentTheme: req.user.theme || 'light'
        }
      });
    } catch (error) {
      console.error('Error getting themes:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch themes'
      });
    }
  })
);

// Set user theme
router.post(
  '/theme',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { themeId } = req.body;

      const availableThemes = ['light', 'dark', 'blue', 'purple', 'green', 'midnight'];
      
      if (!availableThemes.includes(themeId)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid theme selection'
        });
      }

      await User.update({ theme: themeId }, {
        where: { id: userId }
      });

      res.status(200).json({
        status: 'success',
        message: 'Theme updated',
        data: { theme: themeId }
      });
    } catch (error) {
      console.error('Error setting theme:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update theme'
      });
    }
  })
);

// Get available languages
router.get(
  '/languages',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const languages = [
        {
          code: 'en',
          name: 'English',
          nativeName: 'English',
          flag: '🇺🇸',
          isRTL: false
        },
        {
          code: 'es',
          name: 'Spanish',
          nativeName: 'Español',
          flag: '🇪🇸',
          isRTL: false
        },
        {
          code: 'fr',
          name: 'French',
          nativeName: 'Français',
          flag: '🇫🇷',
          isRTL: false
        },
        {
          code: 'de',
          name: 'German',
          nativeName: 'Deutsch',
          flag: '🇩🇪',
          isRTL: false
        },
        {
          code: 'ar',
          name: 'Arabic',
          nativeName: 'العربية',
          flag: '🇸🇦',
          isRTL: true
        },
        {
          code: 'zh',
          name: 'Chinese',
          nativeName: '中文',
          flag: '🇨🇳',
          isRTL: false
        },
        {
          code: 'ja',
          name: 'Japanese',
          nativeName: '日本語',
          flag: '🇯🇵',
          isRTL: false
        },
        {
          code: 'ru',
          name: 'Russian',
          nativeName: 'Русский',
          flag: '🇷🇺',
          isRTL: false
        }
      ];

      res.status(200).json({
        status: 'success',
        data: {
          languages,
          currentLanguage: req.user.language || 'en'
        }
      });
    } catch (error) {
      console.error('Error getting languages:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch languages'
      });
    }
  })
);

// Set user language
router.post(
  '/language',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { languageCode } = req.body;

      const availableLanguages = ['en', 'es', 'fr', 'de', 'ar', 'zh', 'ja', 'ru'];
      
      if (!availableLanguages.includes(languageCode)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid language selection'
        });
      }

      await User.update({ language: languageCode }, {
        where: { id: userId }
      });

      res.status(200).json({
        status: 'success',
        message: 'Language updated',
        data: { language: languageCode }
      });
    } catch (error) {
      console.error('Error setting language:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update language'
      });
    }
  })
);

// Get notification sounds
router.get(
  '/notification-sounds',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const sounds = [
        {
          id: 'default',
          name: 'Default',
          description: 'Standard notification sound',
          duration: 2,
          category: 'message'
        },
        {
          id: 'chime',
          name: 'Chime',
          description: 'Gentle chime sound',
          duration: 1,
          category: 'message'
        },
        {
          id: 'bell',
          name: 'Bell',
          description: 'Clear bell sound',
          duration: 2,
          category: 'message'
        },
        {
          id: 'ding',
          name: 'Ding',
          description: 'Short ding sound',
          duration: 1,
          category: 'message'
        },
        {
          id: 'ringtone-1',
          name: 'Ringtone Classic',
          description: 'Classic phone ringtone',
          duration: 5,
          category: 'call'
        },
        {
          id: 'ringtone-2',
          name: 'Ringtone Modern',
          description: 'Modern ringtone',
          duration: 4,
          category: 'call'
        },
        {
          id: 'vibrate-only',
          name: 'Vibrate Only',
          description: 'No sound, only vibration',
          duration: 0,
          category: 'all'
        },
        {
          id: 'silent',
          name: 'Silent',
          description: 'No sound or vibration',
          duration: 0,
          category: 'all'
        }
      ];

      res.status(200).json({
        status: 'success',
        data: {
          sounds,
          categories: ['message', 'call', 'group', 'all']
        }
      });
    } catch (error) {
      console.error('Error getting notification sounds:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch notification sounds'
      });
    }
  })
);

// Get user's subscription/plan features
router.get(
  '/plan-features',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;

      const user = await User.findByPk(userId);
      const userPlan = user.plan || 'free';

      const planFeatures = {
        free: {
          name: 'Free',
          price: 0,
          currency: 'USD',
          features: [
            { name: 'Audio Calls', enabled: true, limit: 'Unlimited 1:1' },
            { name: 'Video Calls', enabled: true, limit: '30 min per call' },
            { name: 'Group Calls', enabled: false },
            { name: 'Screen Sharing', enabled: false },
            { name: 'Call Recording', enabled: false },
            { name: 'Custom Themes', enabled: false },
            { name: 'Advanced Analytics', enabled: false },
            { name: 'Priority Support', enabled: false },
            { name: 'Storage', enabled: true, limit: '5GB' },
            { name: 'Group Size', enabled: true, limit: 'Up to 10 members' }
          ]
        },
        pro: {
          name: 'Pro',
          price: 9.99,
          currency: 'USD',
          features: [
            { name: 'Audio Calls', enabled: true, limit: 'Unlimited' },
            { name: 'Video Calls', enabled: true, limit: 'Unlimited' },
            { name: 'Group Calls', enabled: true, limit: 'Up to 10 participants' },
            { name: 'Screen Sharing', enabled: true },
            { name: 'Call Recording', enabled: true, limit: '100 hours/month' },
            { name: 'Custom Themes', enabled: true },
            { name: 'Advanced Analytics', enabled: true },
            { name: 'Priority Support', enabled: true },
            { name: 'Storage', enabled: true, limit: '50GB' },
            { name: 'Group Size', enabled: true, limit: 'Up to 50 members' }
          ]
        },
        enterprise: {
          name: 'Enterprise',
          price: 29.99,
          currency: 'USD',
          features: [
            { name: 'Audio Calls', enabled: true, limit: 'Unlimited' },
            { name: 'Video Calls', enabled: true, limit: 'Unlimited' },
            { name: 'Group Calls', enabled: true, limit: 'Up to 100 participants' },
            { name: 'Screen Sharing', enabled: true },
            { name: 'Call Recording', enabled: true, limit: 'Unlimited' },
            { name: 'Custom Themes', enabled: true },
            { name: 'Advanced Analytics', enabled: true },
            { name: 'Priority Support', enabled: true, priority: '24/7' },
            { name: 'Storage', enabled: true, limit: '500GB' },
            { name: 'Group Size', enabled: true, limit: 'Unlimited' },
            { name: 'Custom Domain', enabled: true },
            { name: 'API Access', enabled: true },
            { name: 'White Label', enabled: true }
          ]
        }
      };

      const currentPlan = planFeatures[userPlan];
      const allPlans = planFeatures;

      res.status(200).json({
        status: 'success',
        data: {
          currentPlan: {
            ...currentPlan,
            userId: user.id,
            username: user.username,
            subscribedAt: user.subscribedAt || user.createdAt
          },
          availablePlans: allPlans,
          upgradeUrl: '/billing/upgrade'
        }
      });
    } catch (error) {
      console.error('Error getting plan features:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch plan features'
      });
    }
  })
);

// Get experimental features (beta features)
router.get(
  '/experimental',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;

      const user = await User.findByPk(userId);
      const isBetaTester = user.isBetaTester || false;

      const experimentalFeatures = [
        {
          id: 'voice-commands',
          name: 'Voice Commands',
          description: 'Control the app using voice commands',
          category: 'accessibility',
          status: 'beta',
          requiresPermission: true,
          isActive: true,
          defaultEnabled: false
        },
        {
          id: 'ai-call-summary',
          name: 'AI Call Summary',
          description: 'Get AI-generated summaries of your calls',
          category: 'productivity',
          status: 'beta',
          requiresPermission: true,
          isActive: true,
          defaultEnabled: false
        },
        {
          id: 'real-time-translation',
          name: 'Real-time Translation',
          description: 'Translate conversations in real-time',
          category: 'communication',
          status: 'alpha',
          requiresPermission: true,
          isActive: true,
          defaultEnabled: false
        },
        {
          id: 'background-blur',
          name: 'Background Blur',
          description: 'Blur your background during video calls',
          category: 'video',
          status: 'beta',
          requiresPermission: false,
          isActive: true,
          defaultEnabled: true
        },
        {
          id: 'virtual-background',
          name: 'Virtual Background',
          description: 'Use virtual backgrounds during video calls',
          category: 'video',
          status: 'beta',
          requiresPermission: false,
          isActive: true,
          defaultEnabled: false
        }
      ];

      // Filter features based on user's beta tester status
      const availableFeatures = experimentalFeatures.filter(feature => {
        if (feature.status === 'alpha' && !isBetaTester) {
          return false;
        }
        return feature.isActive;
      });

      // Get user preferences for experimental features
      const userPreferences = await UserFeaturePreference.findAll({
        where: { 
          userId,
          featureId: availableFeatures.map(f => f.id)
        }
      });

      const featuresWithPreferences = availableFeatures.map(feature => {
        const preference = userPreferences.find(p => p.featureId === feature.id);
        return {
          ...feature,
          enabled: preference ? preference.enabled : feature.defaultEnabled,
          requiresOptIn: feature.requiresPermission,
          canEnable: isBetaTester || feature.status !== 'alpha'
        };
      });

      res.status(200).json({
        status: 'success',
        data: {
          features: featuresWithPreferences,
          isBetaTester,
          betaSignupUrl: isBetaTester ? null : '/beta/signup',
          disclaimer: 'Experimental features may be unstable and are subject to change.'
        }
      });
    } catch (error) {
      console.error('Error getting experimental features:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch experimental features'
      });
    }
  })
);

// Request beta access
router.post(
  '/request-beta',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { featureIds, reason } = req.body;

      if (!featureIds || !Array.isArray(featureIds) || featureIds.length === 0) {
        return res.status(400).json({
          status: 'error',
          message: 'Please specify which features you want to test'
        });
      }

      if (!reason || reason.trim().length < 10) {
        return res.status(400).json({
          status: 'error',
          message: 'Please provide a reason (min 10 characters)'
        });
      }

      // In a real application, you would:
      // 1. Store the beta access request in a database
      // 2. Notify administrators
      // 3. Possibly auto-approve based on certain criteria

      // For now, we'll just return a success message
      res.status(200).json({
        status: 'success',
        message: 'Beta access request submitted',
        data: {
          requestedFeatures: featureIds,
          requestId: `beta-request-${Date.now()}`,
          estimatedResponseTime: '2-3 business days'
        }
      });
    } catch (error) {
      console.error('Error requesting beta access:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to submit beta access request'
      });
    }
  })
);

// Reset all feature preferences to defaults
router.post(
  '/reset',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { confirmation } = req.body;

      if (!confirmation || confirmation !== 'RESET ALL SETTINGS') {
        return res.status(400).json({
          status: 'error',
          message: 'Confirmation text must be "RESET ALL SETTINGS"'
        });
      }

      // Delete all user feature preferences
      await UserFeaturePreference.destroy({
        where: { userId }
      });

      // Reset user theme and language to defaults
      await User.update({
        theme: 'light',
        language: 'en'
      }, {
        where: { id: userId }
      });

      res.status(200).json({
        status: 'success',
        message: 'All feature preferences have been reset to defaults',
        data: {
          resetAt: new Date(),
          itemsReset: ['feature_preferences', 'theme', 'language']
        }
      });
    } catch (error) {
      console.error('Error resetting feature preferences:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to reset feature preferences'
      });
    }
  })
);

module.exports = router;