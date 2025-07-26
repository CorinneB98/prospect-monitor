// backend/server.js - Complete Backend API server with web search capabilities
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://*.vercel.app'],
  credentials: true
}));
app.use(express.json());

// Environment variables for API keys
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Web search endpoint using Brave Search API
app.post('/api/web-search', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    if (!BRAVE_API_KEY) {
      return res.status(500).json({ error: 'Brave API key not configured' });
    }

    // Build search URL with parameters
    const searchUrl = new URL('https://api.search.brave.com/res/v1/web/search');
    searchUrl.searchParams.append('q', query);
    searchUrl.searchParams.append('count', '10');
    searchUrl.searchParams.append('freshness', 'pw'); // Past week
    searchUrl.searchParams.append('text_decorations', 'false');
    searchUrl.searchParams.append('search_lang', 'en');
    searchUrl.searchParams.append('country', 'US');

    // Search using Brave Search API
    const searchResponse = await fetch(searchUrl.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY
      }
    });

    if (!searchResponse.ok) {
      throw new Error(`Brave API error: ${searchResponse.status} ${searchResponse.statusText}`);
    }

    const searchData = await searchResponse.json();
    
    // Format results for our application
    const results = searchData.web?.results?.map(result => ({
      title: result.title || 'No title',
      url: result.url || '',
      description: result.description || 'No description',
      published: result.age || 'Recent',
      favicon: result.profile?.img || null
    })) || [];

    res.json({
      success: true,
      query,
      results,
      total: results.length
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ 
      error: 'Search failed', 
      message: error.message 
    });
  }
});

// Prospect news analysis endpoint
app.post('/api/analyze-prospect', async (req, res) => {
  try {
    const { prospect, keywords, searchResults } = req.body;

    if (!prospect || !keywords || !searchResults) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    // Use Claude to analyze the search results
    const analysisResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: `Analyze these search results for "${prospect}" and determine if there's relevant sales prospecting news:

Search Results:
${JSON.stringify(searchResults.slice(0, 8), null, 2)}

Keywords we're monitoring: ${keywords.join(', ')}

Provide a JSON response with this exact structure:
{
  "company": "${prospect}",
  "hasNews": boolean,
  "summary": "Brief summary of relevant news or 'No relevant news found'",
  "newsType": "funding/executive/acquisition/partnership/expansion/other",
  "urgency": "high/medium/low",
  "slackMessage": "Formatted Slack alert with emoji and key details",
  "sourceUrl": "URL of most relevant article if found",
  "confidence": "high/medium/low"
}

Analysis criteria:
- Only set hasNews to true for genuinely relevant recent news that creates sales opportunities
- Focus on funding rounds, executive changes, acquisitions, partnerships, product launches
- Ignore routine press releases, old news, or irrelevant content
- Provide confidence level based on relevance and recency of news
- Create engaging Slack messages with appropriate emojis (🚀 for funding, 👔 for executives, 🤝 for partnerships, etc.)
- If multiple relevant items found, focus on the most important one

RESPOND ONLY WITH VALID JSON. DO NOT include any other text outside the JSON object.`
          }
        ]
      })
    });

    if (!analysisResponse.ok) {
      const errorText = await analysisResponse.text();
      throw new Error(`Claude API error: ${analysisResponse.status} - ${errorText}`);
    }

    const analysisData = await analysisResponse.json();
    let responseText = analysisData.content[0].text;
    
    // Clean up the response to extract JSON
    responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    
    try {
      const analysis = JSON.parse(responseText);
      
      // Validate the response structure
      if (!analysis.company || typeof analysis.hasNews !== 'boolean') {
        throw new Error('Invalid analysis response structure');
      }
      
      res.json({
        success: true,
        analysis
      });
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      console.error('Raw response:', responseText);
      
      // Return a fallback response
      res.json({
        success: true,
        analysis: {
          company: prospect,
          hasNews: false,
          summary: "Unable to analyze search results properly",
          newsType: "other",
          urgency: "low",
          slackMessage: `ℹ️ Unable to analyze news for ${prospect} - manual review needed`,
          sourceUrl: searchResults[0]?.url || null,
          confidence: "low"
        }
      });
    }

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ 
      error: 'Analysis failed', 
      message: error.message 
    });
  }
});

// Combined prospect monitoring endpoint
app.post('/api/monitor-prospect', async (req, res) => {
  try {
    const { prospect, keywords } = req.body;

    if (!prospect || !keywords) {
      return res.status(400).json({ error: 'Prospect and keywords are required' });
    }

    // Step 1: Search for news
    const searchQuery = `"${prospect}" (${keywords.slice(0, 4).join(' OR ')}) 2025`;
    
    const searchResponse = await fetch(`${req.protocol}://${req.get('host')}/api/web-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: searchQuery })
    });

    const searchData = await searchResponse.json();

    if (!searchData.success) {
      throw new Error(searchData.message || 'Search failed');
    }

    // Step 2: Analyze results with Claude
    const analysisResponse = await fetch(`${req.protocol}://${req.get('host')}/api/analyze-prospect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prospect,
        keywords,
        searchResults: searchData.results
      })
    });

    const analysisData = await analysisResponse.json();

    if (!analysisData.success) {
      throw new Error(analysisData.message || 'Analysis failed');
    }

    res.json({
      success: true,
      prospect,
      searchResults: searchData.results,
      analysis: analysisData.analysis,
      metadata: {
        searchQuery,
        totalResults: searchData.total,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Monitor error:', error);
    res.status(500).json({ 
      error: 'Monitoring failed', 
      message: error.message 
    });
  }
});

// Batch monitoring endpoint for multiple prospects
app.post('/api/monitor-all-prospects', async (req, res) => {
  try {
    const { prospects, keywords } = req.body;

    if (!prospects || !Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ error: 'Prospects array is required' });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'Keywords array is required' });
    }

    const results = [];
    
    // Process prospects sequentially to avoid rate limiting
    for (const prospect of prospects) {
      try {
        const monitorResponse = await fetch(`${req.protocol}://${req.get('host')}/api/monitor-prospect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prospect, keywords })
        });

        const monitorData = await monitorResponse.json();
        results.push(monitorData);

        // Small delay to avoid overwhelming APIs
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`Error monitoring ${prospect}:`, error);
        results.push({
          success: false,
          prospect,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: prospects.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        withNews: results.filter(r => r.success && r.analysis?.hasNews).length
      }
    });

  } catch (error) {
    console.error('Batch monitor error:', error);
    res.status(500).json({ 
      error: 'Batch monitoring failed', 
      message: error.message 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    braveApiConfigured: !!BRAVE_API_KEY,
    anthropicApiConfigured: !!ANTHROPIC_API_KEY,
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// Basic info endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'Prospect Monitor API',
    version: '1.0.0',
    endpoints: [
      'GET /api/health',
      'POST /api/web-search',
      'POST /api/analyze-prospect', 
      'POST /api/monitor-prospect',
      'POST /api/monitor-all-prospects'
    ],
    documentation: 'https://github.com/your-repo/prospect-monitor'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Prospect Monitor Backend API',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`📡 Web search API: http://localhost:${PORT}/api/web-search`);
  console.log(`🤖 Analysis API: http://localhost:${PORT}/api/analyze-prospect`);
  console.log(`📊 Monitor API: http://localhost:${PORT}/api/monitor-prospect`);
  console.log(`🔄 Batch Monitor API: http://localhost:${PORT}/api/monitor-all-prospects`);
  console.log(`❤️  Health check: http://localhost:${PORT}/api/health`);
  
  if (!BRAVE_API_KEY) {
    console.warn('⚠️  BRAVE_API_KEY not set - web search will not work');
  }
  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY not set - analysis will not work');
  }
  
  console.log(`✅ Server ready for requests!`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
