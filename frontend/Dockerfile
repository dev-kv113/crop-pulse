# The web app as a container: build the static files, then serve them with nginx.
#
# Used by the `web` service in docker-compose.yml. Production does not use this
# image - there the same `dist/` is served by the host's nginx (see deploy/).

# ---------------------------------------------------------------- build ---
FROM node:20-alpine AS build
WORKDIR /app

# Dependencies first, so a code change does not re-install them on every build.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

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

RUN npm run build

# ---------------------------------------------------------------- serve ---
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
