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

const validateFileContent = (filePath, expectedMimeType) => {
    try {
        const buffer = fs.readFileSync(filePath);
        if (buffer.length === 0) {
            return false;
        }

        const signatures = FILE_SIGNATURES[expectedMimeType];
        if (!signatures) {

            return true;
        }

        const matches = signatures.every((byte, index) => buffer[index] === byte);

        if (expectedMimeType === 'image/webp') {
            const hasRiff = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
            const hasWebp = buffer.slice(8, 12).toString() === 'WEBP';
            return hasRiff && hasWebp;
        }

        return matches;
    } catch (error) {
        void error;
        return false;
    }
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

export const validateImageContent = (req, res, next) => {
    if (!req.files && !req.file) {
        return next();
    }

    const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : [req.file];

    for (const file of files) {
        if (!file || !file.path) continue;

        const isValid = validateFileContent(file.path, file.mimetype);
        if (!isValid) {

            try {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            } catch (e) {
                void e;

            }
            return res.status(400).json({
                message: 'Invalid file content. File does not match its declared type.'
            });
        }
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

export const validateExcelContent = (req, res, next) => {
    if (!req.file && !req.files) {
        return next();
    }

    const file = req.file || (req.files && req.files[0]);
    if (!file || !file.path) {
        return next();
    }

    const isValid = validateFileContent(file.path, file.mimetype);
    if (!isValid) {

        try {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
        } catch (e) {
            void e;

        }
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
