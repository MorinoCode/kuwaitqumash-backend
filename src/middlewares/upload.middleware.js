import multer from 'multer';
import path from 'path';
import fs from 'fs';

const tempDir = 'public/temp';

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

const FILE_SIGNATURES = {

    'image/jpeg': [0xFF, 0xD8, 0xFF],
    'image/png': [0x89, 0x50, 0x4E, 0x47],
    'image/gif': [0x47, 0x49, 0x46, 0x38],
    'image/webp': [0x52, 0x49, 0x46, 0x46],

    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [0x50, 0x4B, 0x03, 0x04],
    'application/vnd.ms-excel': [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1],
};

const HEADER_BYTES_TO_READ = 16;

const validateFileContent = async (filePath, expectedMimeType) => {
    let handle;
    try {
        handle = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(HEADER_BYTES_TO_READ);
        const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES_TO_READ, 0);
        if (bytesRead === 0) {
            return false;
        }

        const signatures = FILE_SIGNATURES[expectedMimeType];
        if (!signatures) {
            return true;
        }

        if (bytesRead < signatures.length) {
            return false;
        }

        const matches = signatures.every((byte, index) => buffer[index] === byte);

        if (expectedMimeType === 'image/webp') {
            if (bytesRead < 12) return false;
            const hasRiff = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
            const hasWebp = buffer.subarray(8, 12).toString('ascii') === 'WEBP';
            return hasRiff && hasWebp;
        }

        return matches;
    } catch (error) {
        void error;
        return false;
    } finally {
        if (handle) {
            await handle.close().catch(() => {});
        }
    }
};

const cleanupTempFiles = async (files) => {
    await Promise.all(
        files
            .filter((f) => f && f.path)
            .map((f) => fs.promises.unlink(f.path).catch(() => {})),
    );
};

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, tempDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {

        cb(null, true);
    } else {
        cb(new Error('Not an image! Please upload an image.'), false);
    }
};

export const validateImageContent = async (req, res, next) => {
    if (!req.files && !req.file) {
        return next();
    }

    const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : [req.file];
    const validatableFiles = files.filter((file) => file && file.path);

    const results = await Promise.all(
        validatableFiles.map((file) => validateFileContent(file.path, file.mimetype)),
    );

    if (results.some((isValid) => !isValid)) {
        await cleanupTempFiles(files);
        return res.status(400).json({
            message: 'Invalid file content. File does not match its declared type.'
        });
    }

    next();
};

const excelFileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/vnd.ms-excel.sheet.macroEnabled.12',
    ];
    const allowedExts = ['.xlsx', '.xls', '.xlsm'];
    const fileExt = path.extname(file.originalname).toLowerCase();

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(fileExt)) {

        cb(null, true);
    } else {
        cb(new Error('Only Excel files (.xlsx, .xls) are allowed!'), false);
    }
};

export const validateExcelContent = async (req, res, next) => {
    if (!req.file && !req.files) {
        return next();
    }

    const file = req.file || (req.files && req.files[0]);
    if (!file || !file.path) {
        return next();
    }

    const isValid = await validateFileContent(file.path, file.mimetype);
    if (!isValid) {
        await cleanupTempFiles([file]);
        return res.status(400).json({
            message: 'Invalid Excel file. File does not match its declared type.'
        });
    }

    next();
};

export const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

export const uploadExcel = multer({
    storage: storage,
    fileFilter: excelFileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024
    }
});
