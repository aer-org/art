#!/bin/bash
# Build the AerArt agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="art-agent"
REGISTRY_IMAGE="ghcr.io/aer-org/${IMAGE_NAME}"
TAG="${1:-latest}"
BASE_IMAGE="${2:-}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

BUILD_ARGS=""
if [ -n "$BASE_IMAGE" ]; then
  BUILD_ARGS="--build-arg BASE_IMAGE=${BASE_IMAGE}"
  IMAGE_NAME="art-agent-${TAG}"
  echo "Building custom agent image on base: ${BASE_IMAGE}"
  echo "Image: ${IMAGE_NAME}:latest"
  ${CONTAINER_RUNTIME} build ${BUILD_ARGS} -t "${IMAGE_NAME}:latest" .
  echo ""
  echo "Build complete!"
  echo "Image: ${IMAGE_NAME}:latest"
else
  echo "Building AerArt agent container image..."
  echo "Image: ${IMAGE_NAME}:${TAG}"
  ${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .
  ${CONTAINER_RUNTIME} tag "${IMAGE_NAME}:${TAG}" "${REGISTRY_IMAGE}:${TAG}"
  echo ""
  echo "Build complete!"
  echo "Image: ${IMAGE_NAME}:${TAG}"
  echo "       ${REGISTRY_IMAGE}:${TAG}"
  echo ""
  echo "Test with:"
  echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
  echo ""
  echo "Push with:"
  echo "  ${CONTAINER_RUNTIME} push ${REGISTRY_IMAGE}:${TAG}"
fi
