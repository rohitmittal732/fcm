const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

// This automatically switches between Render production ENV VAR and local json key.
let serviceAccount;
if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}
// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(cors());
app.use(express.json());

const db = admin.firestore();

// Internal helper for sending multicast
async function sendToTokens(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return { success: false, error: 'No tokens found' };

  const message = {
    notification: { title: title || 'New Notification', body: body || '' },
    data,
    tokens
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    const failedTokens = [];
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) failedTokens.push(tokens[idx]);
      });
    }
    return { success: true, response, failedTokens };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 1. Notify all admins (for new orders)
app.post('/notify-admins', async (req, res) => {
  let { title, body, data } = req.body;
  // Ensure data has the target role if not custom set
  data = { ...(data || {}), role: 'admin', type: 'NEW_ORDER' };
  try {
    const snap = await db.collection('users').where('role', '==', 'admin').get();
    const tokens = [];
    const tokenToRef = {};
    
    snap.forEach(doc => {
      const dbTokens = doc.data().fcm_tokens || [];
      const legacyToken = doc.data().fcm_token;
      if (legacyToken && !dbTokens.includes(legacyToken)) dbTokens.push(legacyToken);
      
      dbTokens.forEach(t => {
        tokens.push(t);
        tokenToRef[t] = doc.ref;
      });
    });
    
    const result = await sendToTokens(tokens, title, body, data);
    
    if (result.failedTokens && result.failedTokens.length > 0) {
      const batch = db.batch();
      result.failedTokens.forEach(failedToken => {
        if (tokenToRef[failedToken]) {
          batch.update(tokenToRef[failedToken], {
            fcm_tokens: admin.firestore.FieldValue.arrayRemove(failedToken)
          });
        }
      });
      await batch.commit();
    }
    
    res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching admins:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Notify specific user or rider (for order updates)
app.post('/notify-user', async (req, res) => {
  const { userId, title, body, orderId } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'Missing userId' });

  // Custom Payload Injection
  const data = {
     type: "ORDER_UPDATE",
     userId: String(userId), // 🔥 Critical for frontend target validation
     click_action: "FLUTTER_NOTIFICATION_CLICK"
  };
  if (orderId) data.orderId = String(orderId);


  try {
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return res.status(200).json({ success: false, error: 'User not found' });
    
    const dbTokens = doc.data().fcm_tokens || [];
    const legacyToken = doc.data().fcm_token;
    if (legacyToken && !dbTokens.includes(legacyToken)) dbTokens.push(legacyToken);
    
    if (dbTokens.length === 0) return res.status(200).json({ success: false, error: 'User has no token' });
    
    const result = await sendToTokens(dbTokens, title, body, data);
    
    if (result.failedTokens && result.failedTokens.length > 0) {
      await doc.ref.update({
        fcm_tokens: admin.firestore.FieldValue.arrayRemove(...result.failedTokens)
      });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Firebase Push Notification Backend running on port ${PORT}`);
});
