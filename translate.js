const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { parseSync, stringifySync } = require('subtitle');
const translate = require('google-translate-api-x');
const crypto = require('crypto');
const pLimit = require('p-limit').default;

const app = express();
const upload = multer({ dest: 'uploads/' });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());

const activeJobs = {};

// Ensure directories exist
['uploads', 'output'].forEach(dir => {
    if (!fs.existsSync(path.join(__dirname, dir))) {
        fs.mkdirSync(path.join(__dirname, dir));
    }
});

async function processTranslation(jobId, inputPath, outputPath) {
    console.log("🚀 Job started:", jobId);

    try {
        const inputSrt = fs.readFileSync(inputPath, 'utf8');
        const nodes = parseSync(inputSrt);
        const cues = nodes.filter(n => n.type === 'cue' && n.data?.text?.trim());

        console.log(`📄 Total cues: ${cues.length}`);

        const BATCH_SIZE = 50;
        const CONCURRENCY = 8;

        const limit = pLimit(CONCURRENCY);

        activeJobs[jobId].total = cues.length;
        activeJobs[jobId].completed = 0;
        activeJobs[jobId].progress = 0;

        const tasks = [];

        for (let i = 0; i < cues.length; i += BATCH_SIZE) {
            const chunkIndex = i / BATCH_SIZE;
            const chunk = cues.slice(i, i + BATCH_SIZE);

            tasks.push(limit(async () => {
                console.log(`⚡ Processing chunk ${chunkIndex}`);

                if (activeJobs[jobId].status === 'cancelled') {
                    console.log(`🛑 Job cancelled before chunk ${chunkIndex}`);
                    return;
                }

                const texts = chunk.map(c =>
                    c.data.text.replace(/\n/g, ' ||| ')
                );

                try {
                    console.log(`🌍 Translating chunk ${chunkIndex}...`);

                    const res = await translate(texts, { from: 'tr', to: 'en' });

                    if (activeJobs[jobId].status === 'cancelled') {
                        console.log(`🛑 Job cancelled after API for chunk ${chunkIndex}`);
                        return;
                    }

                    const translated = Array.isArray(res) ? res : [res];

                    chunk.forEach((node, index) => {
                        if (translated[index]) {
                            node.data.text = translated[index].text.replace(/ \|\|\| /g, '\n');
                        }
                    });

                    activeJobs[jobId].completed += chunk.length;
                    activeJobs[jobId].progress = Math.round(
                        (activeJobs[jobId].completed / activeJobs[jobId].total) * 100
                    );

                    console.log(`✅ Chunk ${chunkIndex} done | Progress: ${activeJobs[jobId].progress}%`);

                } catch (err) {
                    console.error(`❌ Chunk ${chunkIndex} failed:`, err.message);
                }
            }));
        }

        console.log("⏳ Waiting for all chunks...");
        await Promise.allSettled(tasks);

        if (activeJobs[jobId].status === 'cancelled') {
            console.log("🛑 Job fully cancelled");
            return;
        }

        console.log("💾 Writing output file...");
        fs.writeFileSync(outputPath, stringifySync(nodes, { format: 'SRT' }));

        activeJobs[jobId].status = 'completed';
        activeJobs[jobId].progress = 100;

        console.log("🎉 Job completed!");

    } catch (err) {
        console.error("🔥 Job Error:", err);
        activeJobs[jobId].status = 'error';
    } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    }
}

// ROUTES
app.get('/', (req, res) => res.render('index'));

app.post('/translate', upload.single('subtitle'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const jobId = crypto.randomUUID();
    const originalName = req.file.originalname;
    const translatedFileName = originalName.replace(/\.srt$/i, '_EN.srt');
    const outputPath = path.join(__dirname, 'output', translatedFileName);

    activeJobs[jobId] = {
        progress: 0,
        completed: 0,
        total: 0,
        status: 'running',
        downloadLink: `/download/${encodeURIComponent(translatedFileName)}`
    };

    processTranslation(jobId, req.file.path, outputPath);

    res.json({ jobId });
});

app.get('/progress/:jobId', (req, res) => {
    console.log("📡 SSE connected:", req.params.jobId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const interval = setInterval(() => {
        const job = activeJobs[req.params.jobId];

        if (!job) {
            console.log("❌ Job not found:", req.params.jobId);
            res.write(`data: {"status":"not_found"}\n\n`);
            return;
        }

        console.log(`📊 Sending progress: ${job.progress}% | status: ${job.status}`);

        res.write(`data: ${JSON.stringify(job)}\n\n`);

        if (['completed', 'cancelled', 'error'].includes(job.status)) {
            console.log("🔌 Closing SSE");
            clearInterval(interval);
            res.end();
        }
    }, 1000);

    req.on('close', () => {
        console.log("🔌 SSE client disconnected");
        clearInterval(interval);
    });
});

app.post('/cancel/:jobId', (req, res) => {
    console.log("🛑 Cancel request received:", req.params.jobId);
    if (activeJobs[req.params.jobId]) {
        activeJobs[req.params.jobId].status = 'cancelled';
    }
    res.json({ success: true });
});

app.get('/download/:filename', (req, res) => {
    const file = path.join(__dirname, 'output', req.params.filename);
    if (fs.existsSync(file)) res.download(file);
    else res.status(404).send("File not found");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));