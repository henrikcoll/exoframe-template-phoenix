const fs = require('fs');
const path = require('path');

exports.name = 'phoenix';

exports.checkTemplate = async ({ tempDockerDir, folder }) => {
  try {
    fs.readFileSync(path.join(tempDockerDir, folder, 'mix.exs'));
    return true;
  } catch (e) {
    return false;
  }
};


const hasDockerfile = async ({ tempDockerDir, folder }) => {
  try {
    fs.readFileSync(path.join(tempDockerDir, folder, 'Dockerfile'));
    return true;
  } catch (e) {
    return false;
  }
};

const assetsUsesNodejs = async ({ tempDockerDir, folder }) => {
  try {
    fs.readFileSync(path.join(tempDockerDir, folder, 'assets/package.json'));
    return true;
  } catch (e) {
    return false;
  }
}

const phoenixDockerfile = ({ config, tempDockerDir, folder, elixirConfig, usesNodejs }) => 
`FROM hexpm/elixir:${elixirConfig.elixirVersion || '1.13.0'}-erlang-${elixirConfig.erlangVersion || '24.0.3'}-alpine-${elixirConfig.alpineVersion || '3.14.0'} AS build

RUN apk add --no-cache build-base npm

WORKDIR /app

ENV HEX_HTTP_TIMEOUT=20

RUN mix local.hex --force && \
	mix local.rebar --force

ENV MIX_ENV=prod
ENV SECRET_KEY_BASE=nokey

COPY mix.exs mix.lock ./
COPY config config

RUN mix deps.get --only prod && \
	mix deps.compile
${usesNodejs ?
`
COPY assets/package.json assets/package-lock.json ./assets/
RUN npm --prefix ./assets ci --progress=false --no-audit --loglevel=error
`:''}

COPY priv priv
COPY assets assets
COPY lib lib

RUN mix assets.deploy

COPY rel rel
RUN mix do compile, release

FROM alpine:${elixirConfig.alpineVersion || '3.14.0'} AS app
RUN apk add --no-cache libstdc++ openssl ncurses-libs

WORKDIR /app

RUN chown nobody:nobody /app

USER nobody:nobody

COPY --from=build --chown=nobody:nobody /app/_build/prod/rel/${config.name} ./

ENV HOME=/app
ENV MIX_ENV=prod
ENV SECRET_KEY_BASE=nokey
ENV PORT=${config.port}

CMD ["bin/${config.name}", "start"]
`;

exports.executeTemplate = async ({ username, tempDockerDir, folder, resultStream, util, docker, existing, config, serverConfig }) => {
  try {
    util.writeStatus(resultStream, { message: 'Deploying Phoenix project..', level: 'info'});

    let elixirConfig = config.elixir || {}
    const usesNodejs = await assetsUsesNodejs({ tempDockerDir, folder })

    if (!await hasDockerfile({ tempDockerDir, folder })) {
      const dockerfileContent = await phoenixDockerfile({ config, tempDockerDir, folder, elixirConfig, usesNodejs });
      fs.writeFileSync(path.join(tempDockerDir, folder, 'Dockerfile'), dockerfileContent, 'utf-8');
    }

    const buildRes = await docker.build({username, folder, resultStream});
    util.logger.debug('Build result:', buildRes);

    const containerInfo = await docker.start(Object.assign({}, buildRes, {username, folder, existing, resultStream}));
    util.logger.debug(containerInfo.Name);

    const container = await docker.daemon.getContainer(containerInfo.Id);

    if (elixirConfig.releaseCommand) {
      await new Promise((resolve, reject) => {
        container.exec({ Cmd: elixirConfig.releaseCommand }, (err, exec) => {
          if (err)
            return reject(err)
          exec.start({ hijack: true, stdin: true }, (err, stream) => {
            if (err)
              return reject(err)

            stream.on('end', () => {
              return resolve();
            })
          })
        })
      })
    }

    util.writeStatus(resultStream, {message: 'Deployment success!', deployments: [containerInfo], level: 'info'});
    resultStream.end('');

  } catch (e) {
    util.logger.debug('build failed!', e);
    util.writeStatus(resultStream, {message: e.error, error: e.error, log: e.log, level: 'error'});
    resultStream.end('');
  }
};