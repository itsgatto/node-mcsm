/*
*
*	Minecraft Server Messager by Alexei Liulin   codwizard[at]gmail[dot]com
*
*	New network protocol reference (v >= 1.7):       http://wiki.vg/Protocol
*	MC client version and protocol version matching: http://wiki.vg/Protocol_version_numbers
*
*	USAGE:
*
*	var MCSM = require("./MCServerMessager");
*
*	var mcsm = new MCSM({
*		host: "0.0.0.0"
*	});
*
*	mcsm.start();
*
*	setTimeout(function() {
*		mcsm.stop();
*	}, 3600000);
*
*
*/

var net = require("net");
var events = require("events");
var util = require("util");
var iconv = require("iconv-lite");
var varint = require("varint");
var debug = require("debug")("mcsm");

/**
*	MCServerMessager Constructor
*
*	@param	options	The options object
*/
var MCServerMessager = function(options) {

	//default options
	this.options = {
		host: "0.0.0.0",
		port: 25565,
		message: "GRAB A COFFEE, WORK IN PROGRESS",
		motd: "WORK IN PROGRESS",
		players: "0",
		maxPlayers: "10",
		protocolVersion: "47",
		reportedVersion: "1.8.3",
	};

	//Partial or full default options override
	if(typeof(options) === "object") {
		for(var p in options)
			if(this.options.hasOwnProperty(p))
				this.options[p] = options[p];
	}


	this.active = false;
	this.server = null;

	this.clientState = null;

    events.EventEmitter.call(this);
};
util.inherits(MCServerMessager, events.EventEmitter);

/**
*	Options getter
*/
MCServerMessager.prototype.getOption = function(optionName) {
	if(this.options.hasOwnProperty(optionName))
		return this.options[optionName];
	else
		return null;
};

/**
*	Options setter
*/
MCServerMessager.prototype.setOption = function(optionName, optionValue) {
	if(this.options.hasOwnProperty(optionName)) {
		this.options[optionName] = optionValue;

		debug("[*] " + optionName + " option was set to " + optionValue);

		return true;
	} else
		return false;
};


/**
*	Starts the MCSM server
*/
MCServerMessager.prototype.start = function() {
	var $mcsm = this;
	if(!this.active) {
		this.server = net.createServer();

		$mcsm.active = true;

		this.server.on("connection", function(con) {
			debug("Inbound connection from " + con.remoteAddress + ":" + con.remotePort);

			onConnect(con, $mcsm);
		});

		this.server.on("listening", function() {
			debug("[*] MC Server Messager started @ " + $mcsm.options.host + ":" + $mcsm.options.port);

			$mcsm.emit("listen");
		});

		this.server.on("close", function() {
			debug("[-] Shutting down the server...");

			$mcsm.active = false;
			$mcsm.emit("close");
		});

		this.server.on("error", function(err) {
			$mcsm.emit("error", err);
			debug("[!] Error with the server instance: ");
			debug(err);
		});

		this.server.listen(this.options.port, this.options.host);

		return true;

	} else {
		debug("[!] MCSM is already running!");
		return false;
	}
};

/**
*	Stops the MCSM server
*/
MCServerMessager.prototype.stop = function() {
	if(this.active) {
		var that = this;

		this.server.close(function() {
			debug("[-] MC Server Messager has been stopped");

			that.active = false;
		});

		return true;
	} else {
		debug("[!] MCSM is already stopped");
		return false;
	}
};

/**
*	Handles login and server info requests from Minecraft clients
*
*	@param con	MC client TCP socket
*	@param that Reference to MCServerMessage instance
*
*/
function onConnect(con, that) {
	var $mcsm = that;
	con.setNoDelay(true);

	con.on("data", dataHandler);
	function dataHandler(buf) {
		var offset, statusResponse, loginResponse;

		var minorVersion = that.options.reportedVersion.split(".")[1];

		if(minorVersion <= 6) {	//Minecraft clients previous to version 1.7

			offset = 0;
			var type = buf.readUInt8(offset++);

			switch (type) {
				case 0x02:   //Login request
					debug("[*] Login attempt: the client will be disconnected with a message");
					$mcsm.emit("client_connected");

					var loginRequest = decodeLoginRequest_old(buf, offset);

					debug("User " + loginRequest.username + "(protocol v" + loginRequest.protocolVersion +") attempts to login into " + loginRequest.servername);

					loginResponse = buildLoginResponse_old(that.options.message);

					con.write(loginResponse);
				break;

				case 0xFE: //Server status ping request
					statusResponse = buildServerStatusResponse_old(
						that.options.protocolVersion,
						that.options.reportedVersion,
						that.options.motd,
						that.options.players,
						that.options.maxPlayers
					);

					con.write(statusResponse);

					debug("[*] Status ping response was sent to a client");
				break;

				default:   // No idea of type, just close the connection
					$mcsm.emit("client_error", new Error("Unknown packet ID: " + type));
					con.end();
				break;
			}
		}

		else {	//Minecraft 1.7 and above

			var clientStates = {
				handshake: "handshake",
				status: "status",
				login: "login",
				play: "play"
			};

			offset = 0;

			var packetLength = varint.decode(buf, offset);
			offset += varint.decode.bytes;

			var packetId = varint.decode(buf, offset);
			offset += varint.decode.bytes;

			if(packetId === 0x00) {	//Handshake packet

				if(con.clientState == clientStates.status) {	//Server status request packet
					debug("Request for server status packet received");

					statusResponse = buildServerStatusResponse_new(
						that.options.protocolVersion,
						that.options.reportedVersion,
						that.options.motd,
						that.options.players,
						that.options.maxPlayers
					);

					con.write(statusResponse);

					debug("[*] Status ping response was sent to a client");
					$mcsm.emit("client_ping");

				} else if(con.clientState == clientStates.login) {	//Login request
					debug("Login packet received");

					debug("[*] Login attempt: the client will be disconnected with a message");
					$mcsm.emit("client_connected");

					loginResponse = buildLoginReponse_new(that.options.message);

					con.write(loginResponse);

				} else {	//Full handshake packet setting the next state
					var handshakePacket = decodeHandshakePacket(buf, offset);

					debug("Handshake packet with protocol v" + handshakePacket.protocolVersion + " directed to " +
						handshakePacket.serverAddress + ":" + handshakePacket.serverPort + " with next state = " + handshakePacket.nextState);

					if(handshakePacket.nextState == 0x01)	//NextState => STATUS
						con.clientState = clientStates.status;
					else if(handshakePacket.nextState == 0x02) //nextState => LOGIN
						con.clientState = clientStates.login;

					// Packets sent in quick succession group together into
					// the same buffer. Here we call the handler again if there was more data.
					if (buf.length - 1 !== handshakePacket.offset) {
						var newBuf = buf.slice(handshakePacket.offset);
						dataHandler(newBuf);
					}
				}

			} else if(packetId == 0x01) {	//Server ping packet
				debug("Server ping packet received");

				var pingPacket = decodePingPacket(buf, offset);

				var pongPacket = buildPongPacket(pingPacket);

				con.write(pongPacket);
			}
		}
	}

	con.on("close", function(had_error) {
		con.clientState = null;

		debug("Client connection closed");
	});

	con.on("error", function(err) {
		debug("[!] Oops. An error occured while communicating with client\n", err);
		$mcsm.emit("client_error", err);
	});
}

//Old protocol decoders and packet builders

function decodeLoginRequest_old(buf, offset) {
	var protocolVersion = buf.readUInt8(offset++);

	//Get the username of the client
	var usernameLength = buf.readUInt16BE(offset) * 2;
	offset += 2;

	var username = new Buffer(usernameLength);
	buf.copy(username, 0, offset, offset + usernameLength);
	offset += usernameLength;

	username = iconv.decode(username, "utf-16be");

	//Get the servername to which the client si trying to connect
	var servernameLength = buf.readUInt16BE(offset) * 2;
	offset += 2;

	var servername = new Buffer(servernameLength);
	buf.copy(servername, 0, offset, offset + servernameLength);
	offset += servernameLength;

	servername = iconv.decode(servername, "utf-16be");

	var loginRequest = {
		protocolVersion: protocolVersion,
		username: username,
		servername: servername
	};

	return loginRequest;
}

function buildLoginResponse_old(disconnectMessage) {
	var message = new Buffer(iconv.encode(disconnectMessage, "utf16-be"));

	var buf = new Buffer(3 + message.length);

	buf.writeUInt8(0xff, 0);
	buf.writeUInt16BE(message.length / 2, 1);
	message.copy(buf, 3, 0, message.length);

	return buf;
}

function buildServerStatusResponse_old(protocolVersion, reportedVersion, motd, players, maxPlayers) {
	var length = 9 + 2*(protocolVersion.length + 1 + reportedVersion.length + 1 +
				 motd.length + 1 + players.length + 1 + maxPlayers.length + 1);

	var buf = new Buffer(length);
	var offset = 0;

	//initial bytes
	buf.writeUInt8(0xff, (offset++));				//kick packet, byte
	buf.writeUInt16BE((length - 3) / 2, offset);	//proceeding string length, BE short
	offset+=2;

	//UTF-16BE encoded strings delimited by null character 0x0000

	//Strings beginning: 00 a7 00 31 00 00
	var delim = new Buffer([0x00, 0xa7, 0x00, 0x31, 0x00, 0x00]);
	delim.copy(buf, offset, 0, delim.length);
	offset+=delim.length;

	//protocol version, e.g. 47
	protocolVersion = new Buffer(iconv.encode(protocolVersion, "utf16-be"));
	protocolVersion.copy(buf, offset, 0, protocolVersion.length);
	offset+=protocolVersion.length;
	buf.fill(0x00, offset, (offset += 2));

	//Reported Minecraft server version, e.g. 1.4.2
	reportedVersion = new Buffer(iconv.encode(reportedVersion, "utf16-be"));
	reportedVersion.copy(buf, offset, 0, reportedVersion.length);
	offset+=reportedVersion.length;
	buf.fill(0x00, offset, (offset += 2));

	//MOTD
	var MOTD = new Buffer(iconv.encode(motd, "utf16-be"));
	MOTD.copy(buf, offset, 0, MOTD.length);
	offset+=MOTD.length;
	buf.fill(0x00, offset, (offset += 2));

	//Current player count
	var currentPlayers = new Buffer(iconv.encode(players, "utf16-be"));
	currentPlayers.copy(buf, offset, 0, currentPlayers.length);
	offset+=currentPlayers.length;
	buf.fill(0x00, offset, (offset += 2));

	//Max players
	maxPlayers = new Buffer(iconv.encode(maxPlayers, "utf16-be"));
	maxPlayers.copy(buf, offset, 0, maxPlayers.length);
	offset+=maxPlayers.length;
	buf.fill(0x00, offset, (offset += 2));

	return buf;
}

//New protocol decoders and packet builders

function decodeHandshakePacket(buf, offset) {
	//protocol version
	var protocolVersion = varint.decode(buf, offset);
	offset += varint.decode.bytes;

	//server address
	var stringSize = varint.decode(buf, offset);
	offset += varint.decode.bytes;

	var serverAddress = buf.slice(offset, offset + stringSize);
	offset += stringSize;

	//server port
	var serverPort = buf.readUInt16BE(buf,offset);
	offset += 2;

	//next state
	var nextState = varint.decode(buf, offset);
	offset += varint.decode.bytes;

	var handshakePacket = {
		protocolVersion: protocolVersion,
		serverAddress: serverAddress,
		serverPort: serverPort,
		nextState: nextState,
		offset: offset
	};

	return handshakePacket;
}

function decodePingPacket(buf, offset) {
	var HTime = buf.readUInt32BE(offset);
	offset += 4;

	var LTime = buf.readUInt32BE(offset);

	var pingPacket = {
		HTime: HTime,
		LTime: LTime
	};

	return pingPacket;
}

function buildLoginReponse_new(disconnectMessage) {
	var packetId = varint.encode(0x00);
	var packetIdLength = varint.encode.bytes;

	var msg = JSON.stringify({"text": disconnectMessage});

	var msgLength = varint.encode(msg.length);
	var msgLengthLength = varint.encode.bytes;

	var packetSize = varint.encode(packetIdLength + msgLengthLength + msg.length);
	var packetSizeLength = varint.encode.bytes;

	var totalSize = packetSizeLength + packetIdLength + msgLengthLength + msg.length;
	var packet = new Buffer(totalSize);

	var offset = 0;

	(new Buffer(packetSize)).copy(packet, offset, 0, packetSizeLength);
	offset += packetSizeLength;

	(new Buffer(packetId)).copy(packet, offset, 0, packetIdLength);
	offset += packetIdLength;

	(new Buffer(msgLength)).copy(packet, offset, 0, msgLengthLength);
	offset += msgLengthLength;

	(new Buffer(msg)).copy(packet, offset, 0, msg.length);
	offset += msg.length;

	return packet;
}

function buildServerStatusResponse_new(protocolVersion, reportedVersion, motd, players, maxPlayers) {
	var packetID = 0x00;

	var JSONresponse = JSON.stringify({
		description: {
			"text": motd
		},
		players: {
			max: parseInt(maxPlayers,10),
			online: parseInt(players,10)
		},
		version: {
			name: reportedVersion,
			protocol: parseInt(protocolVersion,10)
		}
	});

	packetID = varint.encode(0x00);
	var packetIDLength = varint.encode.bytes;

	var JSONLength = varint.encode(JSONresponse.length);
	var JSONLengthLength = varint.encode.bytes;

	var packetLength = varint.encode(packetIDLength + JSONLengthLength + JSONresponse.length);
	var packetLengthLength = varint.encode.bytes;

	var bufLength = packetLengthLength + packetIDLength + JSONLengthLength + JSONresponse.length;
	var buf = new Buffer(bufLength);
	var offset = 0;

	(new Buffer(packetLength)).copy(buf, offset, 0, packetLength.length);	//packet payload length
	offset += packetLength.length;

	(new Buffer(packetID)).copy(buf, offset, 0, packetIDLength);
	offset += packetIDLength;

	(new Buffer(JSONLength)).copy(buf, offset, 0, JSONLengthLength);	//JSON length
	offset += JSONLengthLength;

	(new Buffer(JSONresponse)).copy(buf, offset, 0, JSONresponse.length + 1);	//JSON status response

	return buf;
}

function buildPongPacket(pingPacket) {
	var packetId = varint.encode(0x01);
	var packetIdLength = varint.encode.bytes;

	var timeLength = 8;

	var packetLength = varint.encode(packetIdLength + timeLength);
	var packetLengthLength = varint.encode.bytes;

	var totalLength = packetLengthLength + packetIdLength + timeLength;
	var packet = new Buffer(totalLength);

	var offset = 0;

	(new Buffer(packetLength)).copy(packet, offset, 0, packetLengthLength);
	offset += packetLengthLength;

	(new Buffer(packetId)).copy(packet, offset, 0, packetIdLength);
	offset += packetIdLength;

	packet.writeUInt32BE(pingPacket.HTime, offset);
	offset += 4;

	packet.writeUInt32BE(pingPacket.LTime, offset);

	return packet;
}


module.exports = MCServerMessager;
