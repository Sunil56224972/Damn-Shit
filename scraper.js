const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { JSDOM } = require("jsdom");

const BASE_URL = "https://www.hackwestern.com";
const OUTPUT_DIR = path.join(__dirname, "site");
const visited = new Set();
const downloadQueue = [];
let totalDownloaded = 0;
let totalFailed = 0;

// Create output directory
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Download a file from URL
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    if (visited.has(url)) return resolve(null);
    visited.add(url);

    const protocol = url.startsWith("https") ? https : http;
    
    const request = protocol.get(url, { 
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "identity"
      },
      timeout: 30000
    }, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        visited.delete(url);
        const redirectUrl = new URL(response.headers.location, url).href;
        return downloadFile(redirectUrl, outputPath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        totalFailed++;
        return resolve(null);
      }

      ensureDir(outputPath);
      const fileStream = fs.createWriteStream(outputPath);
      response.pipe(fileStream);
      fileStream.on("finish", () => {
        fileStream.close();
        totalDownloaded++;
        const size = fs.statSync(outputPath).size;
        console.log(`  ✓ [${totalDownloaded}] ${url.substring(0, 80)}... (${(size/1024).toFixed(1)}KB)`);
        resolve(outputPath);
      });
      fileStream.on("error", (err) => {
        totalFailed++;
        reject(err);
      });
    });

    request.on("error", (err) => {
      totalFailed++;
      resolve(null);
    });

    request.on("timeout", () => {
      request.destroy();
      totalFailed++;
      resolve(null);
    });
  });
}

// Convert URL to local file path
function urlToLocalPath(urlStr, basePath) {
  try {
    const url = new URL(urlStr, BASE_URL);
    let pathname = url.pathname;
    
    // Remove query params for file path but keep for downloading
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    if (pathname.endsWith("/")) pathname += "index.html";
    
    // Handle _next paths
    const localPath = path.join(basePath, pathname.replace(/\?.*$/, ""));
    return localPath;
  } catch {
    return null;
  }
}

// Extract all asset URLs from HTML
function extractAssets(html, baseUrl) {
  const assets = new Set();
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // CSS files - <link rel="stylesheet">
  doc.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="style"]').forEach(el => {
    const href = el.getAttribute("href");
    if (href) assets.add(new URL(href, baseUrl).href);
  });

  // JS files - <script src="">
  doc.querySelectorAll("script[src]").forEach(el => {
    const src = el.getAttribute("src");
    if (src) assets.add(new URL(src, baseUrl).href);
  });

  // Images - <img src=""> and srcset
  doc.querySelectorAll("img").forEach(el => {
    const src = el.getAttribute("src");
    if (src) assets.add(new URL(src, baseUrl).href);

    const srcset = el.getAttribute("srcset") || el.getAttribute("srcSet");
    if (srcset) {
      srcset.split(",").forEach(entry => {
        const url = entry.trim().split(/\s+/)[0];
        if (url) {
          try { assets.add(new URL(url, baseUrl).href); } catch {}
        }
      });
    }
  });

  // Preloaded images via <link rel="preload" as="image">
  doc.querySelectorAll('link[rel="preload"][as="image"]').forEach(el => {
    const href = el.getAttribute("href");
    if (href) assets.add(new URL(href, baseUrl).href);

    const srcset = el.getAttribute("imageSrcSet") || el.getAttribute("imagesrcset");
    if (srcset) {
      srcset.split(",").forEach(entry => {
        const url = entry.trim().split(/\s+/)[0];
        if (url) {
          try { assets.add(new URL(url, baseUrl).href); } catch {}
        }
      });
    }
  });

  // Font files - <link rel="preload" as="font">
  doc.querySelectorAll('link[rel="preload"][as="font"]').forEach(el => {
    const href = el.getAttribute("href");
    if (href) assets.add(new URL(href, baseUrl).href);
  });

  // Manifest
  doc.querySelectorAll('link[rel="manifest"]').forEach(el => {
    const href = el.getAttribute("href");
    if (href) assets.add(new URL(href, baseUrl).href);
  });

  // Favicon and icons
  doc.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(el => {
    const href = el.getAttribute("href");
    if (href) assets.add(new URL(href, baseUrl).href);
  });

  // Background images from inline styles
  const allElements = doc.querySelectorAll("[style]");
  allElements.forEach(el => {
    const style = el.getAttribute("style");
    if (style) {
      const urlMatches = style.matchAll(/url\(["']?([^"')]+)["']?\)/g);
      for (const match of urlMatches) {
        try { assets.add(new URL(match[1], baseUrl).href); } catch {}
      }
    }
  });

  // Also extract from inline <style> tags
  doc.querySelectorAll("style").forEach(el => {
    const text = el.textContent;
    const urlMatches = text.matchAll(/url\(["']?([^"')]+)["']?\)/g);
    for (const match of urlMatches) {
      try { assets.add(new URL(match[1], baseUrl).href); } catch {}
    }
  });

  // OG images / meta images
  doc.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach(el => {
    const content = el.getAttribute("content");
    if (content) {
      try { assets.add(new URL(content, baseUrl).href); } catch {}
    }
  });

  return assets;
}

// Extract URLs from CSS content
function extractCssAssets(cssContent, cssUrl) {
  const assets = new Set();
  const urlMatches = cssContent.matchAll(/url\(["']?([^"')]+)["']?\)/g);
  for (const match of urlMatches) {
    const url = match[1];
    if (url && !url.startsWith("data:")) {
      try { assets.add(new URL(url, cssUrl).href); } catch {}
    }
  }
  return assets;
}

// Rewrite URLs in HTML to local paths
function rewriteHtml(html) {
  // Replace absolute URLs to hackwestern.com with relative paths
  let result = html;
  
  // Replace /_next/ paths (already relative)
  // Replace /landing/ paths (already relative)
  // Replace /shared/ paths (already relative)
  // Replace /meta/ paths (already relative)
  
  // These are already relative, just make sure they work
  // The main thing is to fix any absolute URLs
  result = result.replace(/https:\/\/www\.hackwestern\.com\//g, "./");
  result = result.replace(/https:\/\/www\.hackwestern\.com/g, ".");
  
  return result;
}

// Main scraper function
async function scrape() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     🕷️  Hack Western Website Scraper            ║");
  console.log("║     Scraping: https://www.hackwestern.com       ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Step 1: Download main HTML page
  console.log("📄 Step 1: Downloading main HTML page...");
  const htmlPath = path.join(OUTPUT_DIR, "index.html");
  
  const htmlContent = await new Promise((resolve, reject) => {
    https.get(BASE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }, (response) => {
      let data = "";
      response.on("data", chunk => data += chunk);
      response.on("end", () => resolve(data));
      response.on("error", reject);
    });
  });

  ensureDir(htmlPath);
  fs.writeFileSync(htmlPath, htmlContent);
  console.log(`  ✓ Saved index.html (${(htmlContent.length/1024).toFixed(1)}KB)\n`);

  // Step 2: Extract all asset URLs
  console.log("🔍 Step 2: Extracting asset URLs from HTML...");
  const assets = extractAssets(htmlContent, BASE_URL);
  console.log(`  Found ${assets.size} assets\n`);

  // Step 3: Download all assets
  console.log("📥 Step 3: Downloading all assets...\n");
  
  const assetUrls = [...assets].filter(url => {
    try {
      const parsed = new URL(url);
      // Only download from hackwestern.com
      return parsed.hostname === "www.hackwestern.com" || parsed.hostname === "hackwestern.com";
    } catch {
      return false;
    }
  });

  console.log(`  Downloading ${assetUrls.length} assets from hackwestern.com...\n`);

  // Download in batches of 5
  const batchSize = 5;
  for (let i = 0; i < assetUrls.length; i += batchSize) {
    const batch = assetUrls.slice(i, i + batchSize);
    await Promise.all(batch.map(async (url) => {
      const localPath = urlToLocalPath(url, OUTPUT_DIR);
      if (localPath) {
        await downloadFile(url, localPath);
      }
    }));
  }

  // Step 4: Parse CSS files and download referenced assets (fonts, images)
  console.log("\n🎨 Step 4: Parsing CSS files for additional assets...");
  const cssFiles = assetUrls.filter(u => u.includes(".css"));
  const cssAssets = new Set();
  
  for (const cssUrl of cssFiles) {
    const localCssPath = urlToLocalPath(cssUrl, OUTPUT_DIR);
    if (localCssPath && fs.existsSync(localCssPath)) {
      const cssContent = fs.readFileSync(localCssPath, "utf-8");
      const cssRefs = extractCssAssets(cssContent, cssUrl);
      cssRefs.forEach(a => cssAssets.add(a));
    }
  }

  if (cssAssets.size > 0) {
    console.log(`  Found ${cssAssets.size} additional assets in CSS\n`);
    const cssAssetUrls = [...cssAssets].filter(url => {
      try {
        const parsed = new URL(url);
        return parsed.hostname === "www.hackwestern.com" || parsed.hostname === "hackwestern.com";
      } catch { return false; }
    });

    for (let i = 0; i < cssAssetUrls.length; i += batchSize) {
      const batch = cssAssetUrls.slice(i, i + batchSize);
      await Promise.all(batch.map(async (url) => {
        const localPath = urlToLocalPath(url, OUTPUT_DIR);
        if (localPath) {
          await downloadFile(url, localPath);
        }
      }));
    }
  }

  // Step 5: Download additional known asset paths
  console.log("\n📦 Step 5: Downloading additional known assets...");
  const additionalPaths = [
    "/landing/promo/mobile-bg.webp",
    "/landing/promo/mobile-bg-hero.webp",
    "/landing/promo/sky-noise.webp",
    "/landing/promo/film-strip.svg",
    "/landing/promo/icons/instagram.svg",
    "/landing/promo/icons/linkedin.svg",
    "/landing/promo/icons/x.svg",
    "/landing/promo/icons/medium.svg",
    "/landing/promo/mlh.png",
    "/landing/promo/hero/mountain-1.webp",
    "/landing/promo/hero/mountain-2.webp",
    "/landing/promo/hero/mountain-3.webp",
    "/landing/promo/hero/mountain-4.webp",
    "/landing/promo/projects/window-header.png",
    "/landing/promo/projects/window-header-lines.svg",
    "/landing/promo/projects/traffic-red.svg",
    "/landing/promo/projects/traffic-yellow.svg",
    "/landing/promo/projects/traffic-green.svg",
    "/landing/promo/projects/window-hollow.svg",
    "/landing/promo/projects/tree-object.png",
    "/landing/promo/projects/tree.webp",
    "/landing/promo/projects/branch.webp",
    "/landing/home/about.webp",
    "/landing/home/folder.png",
    "/landing/home/sponsor-bg.png",
    "/landing/home/sponsors-hw13.png",
    "/shared/sponsors/manulife.svg",
    "/shared/sponsors/startech.svg",
    "/shared/sponsors/autodesk.svg",
    "/shared/sponsors/replit.png",
    "/shared/sponsors/cse-trimmed.png",
    "/meta/manifest.json",
    "/meta/og-image.png",
    "/landing/home/footer-bg.webp",
    "/landing/home/footer-people.webp",
    "/favicon.ico",
  ];

  for (let i = 0; i < additionalPaths.length; i += batchSize) {
    const batch = additionalPaths.slice(i, i + batchSize);
    await Promise.all(batch.map(async (assetPath) => {
      const fullUrl = BASE_URL + assetPath;
      const localPath = path.join(OUTPUT_DIR, assetPath);
      await downloadFile(fullUrl, localPath);
    }));
  }

  // Step 6: Download _next/image optimized images (the actual source images)
  console.log("\n🖼️  Step 6: Downloading Next.js optimized images...");
  const nextImageMatches = htmlContent.matchAll(/\/_next\/image\?url=([^&"'\s]+)/g);
  const nextImageSources = new Set();
  
  for (const match of nextImageMatches) {
    const decodedUrl = decodeURIComponent(match[1]);
    nextImageSources.add(decodedUrl);
  }

  console.log(`  Found ${nextImageSources.size} source images\n`);

  for (const imgPath of nextImageSources) {
    const fullUrl = BASE_URL + imgPath;
    const localPath = path.join(OUTPUT_DIR, imgPath);
    await downloadFile(fullUrl, localPath);
  }

  // Step 7: Rewrite HTML to use local paths
  console.log("\n✏️  Step 7: Rewriting HTML for local serving...");
  
  let localHtml = htmlContent;
  
  // Replace /_next/image?url=X&w=Y&q=Z with the actual image path
  localHtml = localHtml.replace(/\/_next\/image\?url=([^&"'\s]+)(?:&amp;|&)w=\d+(?:&amp;|&)q=\d+/g, (match, encodedUrl) => {
    return decodeURIComponent(encodedUrl);
  });
  
  // Remove Cloudflare email protection 
  localHtml = localHtml.replace(/\/cdn-cgi\/l\/email-protection#[a-f0-9]+/g, "mailto:hello@hackwestern.com");
  
  fs.writeFileSync(htmlPath, localHtml);
  console.log("  ✓ HTML rewritten for local serving\n");

  // Summary
  console.log("╔══════════════════════════════════════════════════╗");
  console.log(`║  ✅ Scraping Complete!                           ║`);
  console.log(`║  📁 Output: ${OUTPUT_DIR.substring(0, 36).padEnd(36)}║`);
  console.log(`║  📥 Downloaded: ${String(totalDownloaded).padEnd(31)}║`);
  console.log(`║  ❌ Failed: ${String(totalFailed).padEnd(36)}║`);
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`Open ${path.join(OUTPUT_DIR, "index.html")} in your browser to view the site!`);
}

scrape().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
