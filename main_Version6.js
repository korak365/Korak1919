// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init()
await Actor.init();

// Structure of input is defined in input_schema.json
const { 
    startUrls = [
        'https://www.aliexpress.com/categories/home-garden/products.html',
        'https://www.aliexpress.com/categories/electronics/products.html'
    ], 
    maxRequestsPerCrawl = 200,
    trendingKeywords = ['smart home', 'fidget toys', 'phone accessories', 'pet supplies', 'fitness trackers'],
    minSearchVolume = 1000,
    maxCompetition = 'medium',
    minSellerRating = 4.0,
    priceRange = [5, 50],
    minMonthlyOrders = 100,
    marginTarget = 200,
    enableNicheScore = true
} = (await Actor.getInput()) ?? {};

// Proxy configuration to rotate IP addresses and prevent blocking
const proxyConfiguration = await Actor.createProxyConfiguration();

// Store to track analyzed products
const kvStore = await KeyValueStore.open();
const previousAnalysis = (await kvStore.getValue('previousAnalysis')) || {};

const log = Actor.getLogger();

// Track niche opportunities
const nicheOpportunities = [];
const competitionAnalysis = {};

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ request, $, log }) {
        log.info('Processing AliExpress products:', { url: request.loadedUrl });

        try {
            // Extract products from AliExpress
            scrapeAliExpressProducts($, log, request.loadedUrl);
        } catch (error) {
            log.error('Error processing page:', { 
                url: request.loadedUrl,
                error: error.message 
            });
        }
    },
    
    errorHandler: async ({ request, error, log }) => {
        log.warning('Request failed:', { 
            url: request.loadedUrl,
            error: error.message 
        });
    },
});

async function scrapeAliExpressProducts($, log, pageUrl) {
    // AliExpress product selectors - adjust based on actual site structure
    $('div[id*="card-item"], div.search-item-card, div[class*="productCard"]').each((index, element) => {
        const $product = $(element);
        
        // Extract product information
        const productName = $product.find('h2, .productCardInfo-title, span[title]').text().trim() || 'N/A';
        const productUrl = $product.find('a[href*="/item/"]').attr('href') || 'N/A';
        const fullUrl = productUrl && !productUrl.startsWith('http') ? `https://www.aliexpress.com${productUrl}` : productUrl;
        
        // Extract price
        const priceText = $product.find('.productCardInfo-priceText, .search-card-e-price-main').text().trim() || 'N/A';
        const price = parsePrice(priceText);
        
        // Extract seller information
        const sellerName = $product.find('.search-card-e-storeIcon, [class*="sellerName"]').text().trim() || 'Unknown Seller';
        const sellerRatingText = $product.find('[class*="rating"], .search-card-e-starRating').text().trim() || '0';
        const sellerRating = parseFloat(sellerRatingText) || 0;
        
        // Extract monthly sales/orders
        const ordersText = $product.find('[class*="sold"], [class*="orders"]').text().trim() || '0';
        const monthlyOrders = extractOrderCount(ordersText);
        
        // Extract category from page URL
        const category = extractCategoryFromUrl(pageUrl);

        if (!productName || productName === 'N/A') return;
        if (price < priceRange[0] || price > priceRange[1]) return;
        if (sellerRating < minSellerRating) return;
        if (monthlyOrders < minMonthlyOrders) return;

        // Find matching keywords
        const matchedKeywords = trendingKeywords.filter(keyword => 
            productName.toLowerCase().includes(keyword.toLowerCase())
        );

        if (matchedKeywords.length === 0) return;

        // Process each matched keyword
        for (const keyword of matchedKeywords) {
            processNicheOpportunity({
                productName,
                keyword,
                category,
                price,
                sellerName,
                sellerRating,
                monthlyOrders,
                productUrl: fullUrl,
                log
            });
        }
    });
}

async function processNicheOpportunity(data) {
    const { 
        productName, 
        keyword, 
        category, 
        price, 
        sellerName, 
        sellerRating, 
        monthlyOrders,
        productUrl,
        log 
    } = data;

    const productKey = `${keyword}-${productName}`.toLowerCase();
    const currentTimestamp = new Date().toISOString();

    // Estimate search volume and competition
    const estimatedSearchVolume = estimateSearchVolume(keyword);
    const estimatedCompetition = estimateCompetitionLevel(monthlyOrders);

    // Check if meets minimum search volume
    if (estimatedSearchVolume < minSearchVolume) return;

    // Check competition level
    if (exceedsMaxCompetition(estimatedCompetition, maxCompetition)) return;

    // Calculate profitability metrics
    const recommendedRetailPrice = calculateRetailPrice(price, marginTarget);
    const profitPerUnit = recommendedRetailPrice - price;
    const profitMargin = ((profitPerUnit / recommendedRetailPrice) * 100).toFixed(2);
    const roi = ((profitPerUnit / price) * 100).toFixed(2);

    // Calculate niche score if enabled
    let nicheScore = 0;
    if (enableNicheScore) {
        nicheScore = calculateNicheScore({
            searchVolume: estimatedSearchVolume,
            competition: estimatedCompetition,
            monthlyOrders,
            profitMargin,
            sellerRating
        });
    }

    // Determine viability
    const isViable = profitMargin >= marginTarget && estimatedCompetition !== 'high';
    const viability = isViable ? 'High Potential' : 'Moderate Potential';

    // Track competition analysis
    if (!competitionAnalysis[keyword]) {
        competitionAnalysis[keyword] = {
            keyword,
            searchVolume: estimatedSearchVolume,
            competitionLevel: estimatedCompetition,
            topSellers: 1,
            averageRating: sellerRating,
            priceRange: `$${price.toFixed(2)}`,
            trendDirection: determineTrendDirection(monthlyOrders)
        };
    } else {
        const existing = competitionAnalysis[keyword];
        existing.topSellers += 1;
        existing.averageRating = ((existing.averageRating + sellerRating) / 2).toFixed(1);
    }

    log.info(`Niche opportunity found: ${productName}`, {
        keyword,
        searchVolume: estimatedSearchVolume,
        profitMargin: `${profitMargin}%`,
        nicheScore,
        viability
    });

    // Push niche finder data
    await Dataset.pushData({
        productName,
        keyword,
        category,
        searchVolume: estimatedSearchVolume,
        competition: estimatedCompetition,
        monthlyOrders,
        profitPotential: `$${profitPerUnit.toFixed(2)} per unit`,
        sellerRating: sellerRating.toFixed(1),
        productUrl,
        viability
    });

    // Push profitability metrics
    await Dataset.pushData({
        productName,
        keyword,
        wholesalePrice: `$${price.toFixed(2)}`,
        recommendedRetailPrice: `$${recommendedRetailPrice.toFixed(2)}`,
        potentialProfit: `$${profitPerUnit.toFixed(2)}`,
        profitMargin: parseFloat(profitMargin),
        roi: parseFloat(roi),
        breakEvenPoint: Math.ceil(100 / profitPerUnit) // Approximate break-even for $100 ad spend
    });

    // Push overview data
    await Dataset.pushData({
        productName,
        keyword,
        searchVolume: estimatedSearchVolume,
        monthlyOrders,
        wholesalePrice: `$${price.toFixed(2)}`,
        recommendedRetailPrice: `$${recommendedRetailPrice.toFixed(2)}`,
        profitMargin: parseFloat(profitMargin),
        nicheScore
    });

    // Track in previous analysis
    previousAnalysis[productKey] = {
        productName,
        keyword,
        searchVolume: estimatedSearchVolume,
        profitMargin,
        nicheScore,
        analyzedAt: currentTimestamp
    };
}

// Helper function to parse price from text
function parsePrice(priceText) {
    const match = priceText.match(/[\$€£]?\s*([\d,.]+)/);
    if (match) {
        return parseFloat(match[1].replace(/,/g, ''));
    }
    return 0;
}

// Helper function to extract order count
function extractOrderCount(ordersText) {
    const match = ordersText.match(/(\d+(?:\.?\d+)?)[K+]*/);
    if (match) {
        let count = parseFloat(match[1]);
        if (ordersText.includes('K')) count *= 1000;
        return Math.floor(count);
    }
    return 0;
}

// Helper function to extract category from URL
function extractCategoryFromUrl(url) {
    const match = url.match(/categories\/([^/]+)/);
    return match ? match[1].replace('-', ' ').toUpperCase() : 'General';
}

// Helper function to estimate search volume based on keyword
function estimateSearchVolume(keyword) {
    // Mock search volume data - in production, you'd integrate with Google Keyword Planner API
    const searchVolumeMap = {
        'smart home': 8100,
        'fidget toys': 22200,
        'phone accessories': 14800,
        'pet supplies': 18100,
        'fitness trackers': 12100,
        'bluetooth speakers': 15600,
        'phone cases': 27100,
        'usb cables': 11000,
        'screen protectors': 9900,
        'wireless chargers': 10800
    };
    
    return searchVolumeMap[keyword.toLowerCase()] || Math.floor(Math.random() * 20000) + 1000;
}

// Helper function to estimate competition level
function estimateCompetitionLevel(monthlyOrders) {
    if (monthlyOrders > 5000) return 'high';
    if (monthlyOrders > 1000) return 'medium';
    return 'low';
}

// Helper function to check if competition exceeds maximum
function exceedsMaxCompetition(estimatedCompetition, maxComp) {
    const competitionLevels = { 'low': 1, 'medium': 2, 'high': 3 };
    const maxCompLevel = competitionLevels[maxComp] || 2;
    return competitionLevels[estimatedCompetition] > maxCompLevel;
}

// Helper function to calculate recommended retail price
function calculateRetailPrice(wholesalePrice, targetMarginPercent) {
    // Formula: Retail = Wholesale / (1 - (Margin% / 100))
    return wholesalePrice / (1 - (targetMarginPercent / 100));
}

// Helper function to calculate niche score (0-100)
function calculateNicheScore(metrics) {
    const { searchVolume, competition, monthlyOrders, profitMargin, sellerRating } = metrics;
    
    let score = 0;
    
    // Search volume component (0-30)
    if (searchVolume > 10000) score += 30;
    else if (searchVolume > 5000) score += 20;
    else if (searchVolume > 1000) score += 10;
    
    // Competition component (0-25)
    if (competition === 'low') score += 25;
    else if (competition === 'medium') score += 15;
    else score += 5;
    
    // Monthly orders component (0-20)
    if (monthlyOrders > 1000) score += 20;
    else if (monthlyOrders > 500) score += 15;
    else if (monthlyOrders > 100) score += 10;
    
    // Profit margin component (0-15)
    if (profitMargin > 300) score += 15;
    else if (profitMargin > 200) score += 10;
    else if (profitMargin > 100) score += 5;
    
    // Seller rating component (0-10)
    if (sellerRating > 4.8) score += 10;
    else if (sellerRating > 4.5) score += 8;
    else if (sellerRating > 4.0) score += 5;
    
    return Math.min(100, score);
}

// Helper function to determine trend direction
function determineTrendDirection(monthlyOrders) {
    if (monthlyOrders > 3000) return 'Upward';
    if (monthlyOrders > 500) return 'Stable';
    return 'Emerging';
}

await crawler.run(startUrls);

// Push competition analysis data
for (const [keyword, analysis] of Object.entries(competitionAnalysis)) {
    await Dataset.pushData(analysis);
}

// Save updated analysis for next run
await kvStore.setValue('previousAnalysis', previousAnalysis);

log.info('Niche finding analysis completed', {
    opportunitiesFound: nicheOpportunities.length,
    keywordsAnalyzed: Object.keys(competitionAnalysis).length,
    productsTracked: Object.keys(previousAnalysis).length
});

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();