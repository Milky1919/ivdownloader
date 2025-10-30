const express = require('express');
const cors = require('cors');
const path = require('path');

const puppeteer = require('puppeteer');
const archiver = require('archiver');
const { PDFDocument, rgb } = require('pdf-lib');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helper Functions ---

/**
 * Fetches the Base64 source of an image from a given URL using Puppeteer, handling spread view.
 * @param {object} puppeteerPage - The Puppeteer page object.
 * @param {string} url - The URL to navigate to.
 * @param {string} selector - The CSS selector for the image.
 * @param {number} pageNumber - The requested page number.
 * @returns {Promise<string|null>} The Base64 image string or null if not found.
 */
const getImageBase64 = async (puppeteerPage, url, selector, pageNumber) => {
    // Using 'networkidle0' is a safer bet to ensure all dynamic content,
    // including the Base64 image source, is fully loaded.
    await puppeteerPage.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await puppeteerPage.waitForSelector(selector, { timeout: 30000 });

    return puppeteerPage.evaluate((sel, pNum) => {
        const imageElements = document.querySelectorAll(sel);
        // Filter for elements that are actual images with a data URI source.
        const dataImageSources = Array.from(imageElements)
            .map(img => img.src)
            .filter(src => src && src.startsWith('data:image'));

        const numImages = dataImageSources.length;

        // Requirement: Handle single page view
        if (numImages === 1) {
            return dataImageSources[0];
        }

        // Requirement: Handle spread view (2 images)
        if (numImages === 2) {
            // On a spread, an even page number corresponds to the left image (index 0)
            // and an odd page number to the right image (index 1).
            if (pNum % 2 === 0) { // Even page number
                return dataImageSources[0]; // Return first image
            } else { // Odd page number
                return dataImageSources[1]; // Return second image
            }
        }

        // Requirement: Handle error cases (0, 3, or more images)
        console.error(`Found ${numImages} images for selector '${sel}' on page ${pNum}, but expected 1 or 2.`);
        return null;
    }, selector, pageNumber);
};

/**
 * Parses a string representing a page range (e.g., "1-10", "5") into an array of numbers.
 * @param {string} rangeStr - The page range string.
 * @returns {number[]} An array of page numbers.
 */
const parsePageRange = (rangeStr) => {
    if (rangeStr.includes('-')) {
        const [start, end] = rangeStr.split('-').map(Number);
        if (isNaN(start) || isNaN(end) || start > end) return [];
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    const page = Number(rangeStr);
    return isNaN(page) ? [] : [page];
};

/**
 * Extracts components from a Base64 data URI.
 * @param {string} dataURI - The Base64 data URI.
 * @returns {{mimeType: string, extension: string, data: string}|null}
 */
const parseDataURI = (dataURI) => {
    const match = dataURI.match(/^data:(image\/(.+?));base64,(.*)$/);
    if (!match) return null;

    const mimeType = match[1];
    let extension = match[2];
    // Handle complex mime types like 'svg+xml' -> 'svg'
    if (extension.includes('+')) {
        extension = extension.split('+')[0];
    }
     // Simple sanitization
    extension = extension.replace(/[^a-zA-Z0-9]/g, '');

    return { mimeType, extension, data: match[3] };
};


// --- API Endpoints ---

// Test download endpoint
app.post('/api/download-single', async (req, res) => {
    const { group_name, pdf, page, selector } = req.body;

    if (!group_name || !pdf || !page || !selector) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const url = `https://viewer.impress.co.jp/viewer.html?group_name=${group_name}&pdf=${pdf}&page=${page}`;
    let browser = null;

    try {
        const launchOptions = {};
        // --no-sandbox is required for running in containerized environments (e.g., Docker).
        // Use an environment variable to control this for flexibility.
        if (process.env.PUPPETEER_NO_SANDBOX) {
            launchOptions.args = ['--no-sandbox', '--disable-setuid-sandbox'];
        }
        browser = await puppeteer.launch(launchOptions);
        const puppeteerPage = await browser.newPage();
        const base64Image = await getImageBase64(puppeteerPage, url, selector, page);

        if (!base64Image) {
            return res.status(404).json({ error: 'Image selector not found or image has no src.' });
        }

        const imageInfo = parseDataURI(base64Image);
        if (!imageInfo) {
            return res.status(500).json({ error: 'Invalid Base64 image format.' });
        }

        const buffer = Buffer.from(imageInfo.data, 'base64');

        res.setHeader('Content-Type', imageInfo.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="page_${page}.${imageInfo.extension}"`);
        res.send(buffer);

    } catch (error) {
        console.error('Error during single page download:', error);
        res.status(500).json({ error: `An error occurred: ${error.message}` });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// --- SSE Global State ---
// Caution: This is a simple in-memory solution. In a real-world, scalable application,
// you would use a more robust solution like Redis or a dedicated message broker.
const sseClients = new Map();

// --- Server-Sent Events (SSE) Endpoint ---
app.get('/api/progress', (req, res) => {
    // A unique ID for each client is essential for targeted updates.
    const clientId = req.query.clientId;
    if (!clientId) {
        res.status(400).send('clientId is required');
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.set(clientId, res);
    console.log(`Client connected for SSE: ${clientId}`);

    req.on('close', () => {
        sseClients.delete(clientId);
        console.log(`Client disconnected from SSE: ${clientId}`);
    });
});

/**
 * Sends a progress update to a specific client via SSE.
 * @param {string} clientId - The unique identifier for the client.
 * @param {object} data - The data payload to send.
 */
const sendProgress = (clientId, data) => {
    const client = sseClients.get(clientId);
    if (client) {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
};


// Batch download endpoint
app.post('/api/download-batch', async (req, res) => {
    const { group_name, pdf, page_range, selector, output_format, clientId } = req.body;

    if (!group_name || !pdf || !page_range || !selector || !output_format || !clientId) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const pages = parsePageRange(page_range);
    if (pages.length === 0) {
        return res.status(400).json({ error: 'Invalid page range provided.' });
    }

    let browser = null;

    try {
        const launchOptions = {};
        if (process.env.PUPPETEER_NO_SANDBOX) {
            launchOptions.args = ['--no-sandbox', '--disable-setuid-sandbox'];
        }
        browser = await puppeteer.launch(launchOptions);
        const puppeteerPage = await browser.newPage();

        const images = [];
        const failedPages = [];
        const totalPages = pages.length;

        for (let i = 0; i < totalPages; i++) {
            const page = pages[i];
            const progress = Math.round(((i + 1) / totalPages) * 100);
            const url = `https://viewer.impress.co.jp/viewer.html?group_name=${group_name}&pdf=${pdf}&page=${page}`;

            sendProgress(clientId, { type: 'log', message: `Fetching page ${page} (${i + 1}/${totalPages})...` });

            try {
                const base64Image = await getImageBase64(puppeteerPage, url, selector, page);
                if (base64Image) {
                    images.push({ page, base64Image });
                    sendProgress(clientId, { type: 'log', message: `Successfully fetched page ${page}.` });
                } else {
                    const reason = 'Image source was empty or not found.';
                    failedPages.push({ page, reason });
                    sendProgress(clientId, { type: 'log', message: `Failed to fetch page ${page}: ${reason}`, isError: true });
                }
                 // Keep a delay to avoid overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 1500));

            } catch (pageError) {
                console.error(`Failed to fetch page ${page}:`, pageError.message);
                let reason = pageError.message;
                if (pageError.name === 'TimeoutError') {
                    reason = 'Timeout waiting for page/selector.';
                }
                failedPages.push({ page, reason });
                sendProgress(clientId, { type: 'log', message: `Failed to fetch page ${page}: ${reason}`, isError: true });
            }

            sendProgress(clientId, { type: 'progress', value: progress });
        }

        sendProgress(clientId, { type: 'log', message: 'All pages processed. Compiling output file...' });

        if (images.length === 0) {
            return res.status(404).json({ error: 'No images could be downloaded.' });
        }

        // Expose detailed failed pages info to the client
        if (failedPages.length > 0) {
            res.setHeader('X-Failed-Pages', JSON.stringify(failedPages));
            res.setHeader('Access-Control-Expose-Headers', 'X-Failed-Pages');
        }

        if (output_format === 'zip') {
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${group_name}.zip"`);
            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.pipe(res);
            for (const img of images) {
                const imageInfo = parseDataURI(img.base64Image);
                if (imageInfo) {
                    const buffer = Buffer.from(imageInfo.data, 'base64');
                    archive.append(buffer, { name: `page_${img.page}.${imageInfo.extension}` });
                }
            }
            await archive.finalize();

        } else if (output_format === 'pdf') {
            const pdfDoc = await PDFDocument.create();
            for (const img of images) {
                const imageInfo = parseDataURI(img.base64Image);
                if (!imageInfo) continue;

                try {
                    const buffer = Buffer.from(imageInfo.data, 'base64');
                    let image;
                    if (imageInfo.mimeType === 'image/png') {
                        image = await pdfDoc.embedPng(buffer);
                    } else if (imageInfo.mimeType === 'image/jpeg' || imageInfo.mimeType === 'image/jpg') {
                        image = await pdfDoc.embedJpg(buffer);
                    } else {
                        console.warn(`Skipping unsupported image type for PDF: ${imageInfo.mimeType}`);
                        continue; // Skip unsupported types for PDF
                    }

                    const pdfPage = pdfDoc.addPage([image.width, image.height]);
                    pdfPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });

                } catch (pdfError) {
                    console.error(`Failed to embed page ${img.page} into PDF:`, pdfError.message);
                }
            }
            const pdfBytes = await pdfDoc.save();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${group_name}.pdf"`);
            res.send(Buffer.from(pdfBytes));
        }

        sendProgress(clientId, { type: 'complete', failedPages });

    } catch (error) {
        console.error('Error during batch download:', error);
        sendProgress(clientId, { type: 'error', message: error.message });
        res.status(500).json({ error: `An error occurred: ${error.message}` });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});


app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
