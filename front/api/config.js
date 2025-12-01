// Vercel serverless function to return API configuration
// This reads from Vercel's environment variables at runtime
module.exports = async (req, res) => {
  // Set CORS headers to allow requests from your app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Return the API key from environment variables
  const apiKey = process.env.API_KEY || '';

  return res.status(200).json({
    apiKey: apiKey
  });
};












