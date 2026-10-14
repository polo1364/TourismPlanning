// Local-only integration server. These fixed credentials exist only in test processes.
const { createCloud, digest } = require('../cloud-server.cjs');
const server = createCloud({
    origin: 'https://travel.example.test', passwordHash: digest('share-browser-test').toString('hex'),
    shareDirectory: process.argv[2], login: async () => ({ ready: false }),
    usage: async () => ({ available: false }), generate: async () => { throw new Error('Generation is not part of share tests'); }
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
