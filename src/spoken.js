// Spoken lines drop the project prefix of a session title ("Other: Mailer" -> "Mailer"); on-screen titles are not touched.
const PREFIX = /\b(?:Other|Titans|Theseus app):\s+/gi;
const spoken = line => String(line == null ? '' : line).replace(PREFIX, '');
module.exports = { spoken };
