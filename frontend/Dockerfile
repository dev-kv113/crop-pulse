# The web app as a container: build the static files, then serve them with nginx.
#
# Used by the `web` service in docker-compose.yml, locally and in production.
# In production the host's nginx sits in front of it for HTTPS (see deploy/).

# ---------------------------------------------------------------- build ---
# Node 22: maplibre's dependencies require it (>= 22).
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a code change does not re-install them on every build.
COPY package.json package-lock.json .npmrc ./
# npm can crash mid-install ("Exit handler never called!") and still exit 0,
# leaving half a node_modules. Check the toolchain really arrived, so a network
# hiccup fails here, by name, rather than as "tsc: not found" two steps later.
RUN npm ci && test -x node_modules/.bin/tsc && test -x node_modules/.bin/vite

COPY . .

# Empty means "same origin": the browser calls /api/... on whatever host served
# the page, and nginx below passes it on to the API container. No CORS, and no
# address baked in that only works on one machine.
ARG VITE_API_BASE_URL=""
ARG VITE_MAPTILER_KEY=""
ARG VITE_ANALYTICS_URL="https://analytics.geotranstech.com"
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_MAPTILER_KEY=$VITE_MAPTILER_KEY \
    VITE_ANALYTICS_URL=$VITE_ANALYTICS_URL

# Cap Node's heap so the build fits beside the running stack on a 2 GB server.
# Without a cap Node sizes its heap from total RAM and can push the box into
# the OOM killer mid-deploy; 1 GB is enough for this app's build.
RUN NODE_OPTIONS=--max-old-space-size=1024 npm run build

# ---------------------------------------------------------------- serve ---
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
