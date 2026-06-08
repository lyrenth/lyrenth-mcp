# Lyrenth MCP server: compile the TypeScript stdio server and run it.
#
# Glama builds this image, starts the container, and sends an MCP introspection
# request (initialize + tools/list). The tool is registered at startup and no
# API key is required to start or to introspect (LYRENTH_API_KEY is only needed
# when the read_url tool is actually called), so the Glama check passes with no
# environment configured.
FROM node:20-alpine

WORKDIR /app

# Install dependencies, including the dev deps needed to compile TypeScript.
# Skip the package "prepare" build hook here; we build explicitly below once the
# sources are copied in.
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

# Compile to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Speak MCP over stdio.
ENTRYPOINT ["node", "dist/index.js"]
