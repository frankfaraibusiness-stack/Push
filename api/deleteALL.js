const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

// Change this to your own secret (must match the frontend)
const SECRET = 'delete-everything-123';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { secret } = req.body;
  if (secret !== SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  try {
    const db = admin.firestore();
    const auth = admin.auth();
    const results = {};

    // 1. Delete all Auth users (paginated)
    let usersDeleted = 0;
    let nextPageToken;
    do {
      const listUsersResult = await auth.listUsers(1000, nextPageToken);
      const uids = listUsersResult.users.map(u => u.uid);
      if (uids.length) {
        await auth.deleteUsers(uids);
        usersDeleted += uids.length;
      }
      nextPageToken = listUsersResult.pageToken;
    } while (nextPageToken);
    results.authUsersDeleted = usersDeleted;

    // 2. Delete all Firestore collections (including subcollections)
    const collections = await db.listCollections();
    for (const collection of collections) {
      await db.recursiveDelete(collection);
    }
    results.firestoreCollectionsDeleted = collections.length;

    res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('Deletion error:', error);
    res.status(500).json({ error: error.message });
  }
};
